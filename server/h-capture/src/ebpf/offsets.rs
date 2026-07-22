//! Pure offset-resolution for static-binary (Bun / BoringSSL) eBPF targets.
//!
//! The Phase-3 static-target path (`crate::ebpf::source`) locates `SSL_read` /
//! `SSL_write` in a symbol-stripped, statically-linked TLS stack by byte
//! signature → ELF **file offset**, then attaches a uprobe at that offset.
//! Resolving the offsets from a binary's bytes is pure (it touches no kernel,
//! no aya, no tokio) — the fiddly part lives here, cross-platform, so it is
//! unit-tested on every host without the BPF toolchain or `CAP_BPF`. The
//! Linux-only loader keeps only the aya attach glue around these helpers.
//!
//! Everything here is deterministic over the input bytes: the same `data` +
//! `target` always yield the same offsets, so a per-inode result can be cached
//! as "seen" by the loader. Signatures are version-specific **data** (a
//! prologue pins one statically-linked build), never logic — see
//! [`flavor_signatures`] and the Phase-3 design note.

use h_common::config::EbpfTarget;

use crate::ebpf::sigscan::{scan_elf_executable, Signature};

/// Built-in BoringSSL prologue signatures for a flavor, using the anchor +
/// window technique. `SSL_read`'s prologue is distinctive enough to match
/// uniquely; the `SSL_write` prologue is generic (a common register-save
/// sequence appears many times), so it is located as the nearest match in a
/// window *after* the `SSL_read` anchor — robust to the small per-build drift
/// in the inter-function distance that a hardcoded delta would miss.
pub(crate) struct FlavorSig {
    /// Distinctive `SSL_read` prologue — must match uniquely (the anchor).
    pub read_sig: &'static str,
    /// `SSL_write` prologue — generic; resolved as the first match within
    /// `write_window` bytes after the `SSL_read` anchor.
    pub write_sig: &'static str,
    pub write_window: u64,
}

/// Built-in signatures per flavor. Returns `None` for `boringssl` (generic): a
/// prologue is specific to one statically-linked build, so a bare `boringssl`
/// target must supply `write_sig`/`read_sig`/`*_offset` in config.
///
/// The `bun` signatures are the BoringSSL `SSL_read`/`SSL_write` x86-64
/// prologues from Bun v1.3.x profile builds (the runtime Claude Code ships),
/// matching the read-anchored, windowed-write approach from the eunomia-bpf
/// AgentSight project (MIT). They are still version-bound data — a future Bun
/// line may shift the prologue; override via config when that happens.
pub(crate) fn flavor_signatures(flavor: &str) -> Option<FlavorSig> {
    match flavor {
        "bun" | "boringssl-bun" | "claude-code" => Some(FlavorSig {
            read_sig: "55 48 89 e5 41 57 41 56 53 50 48 83 bf 98 00 00 00 00 74",
            write_sig:
                "55 48 89 e5 41 57 41 56 41 55 41 54 53 48 83 ec 18 41 89 d7 49 89 f6 48 89 fb",
            write_window: 0x10000,
        }),
        _ => None,
    }
}

/// Locate a function as the first signature match within `window` bytes after an
/// `anchor` offset. Used for the generic `SSL_write` prologue once the unique
/// `SSL_read` anchor is known — handles a prologue that occurs many times across
/// the binary by scoping to the SSL function's neighborhood.
pub(crate) fn resolve_windowed(
    data: &[u8],
    pattern: &str,
    anchor: u64,
    window: u64,
    what: &str,
    binary: &str,
) -> Option<u64> {
    let sig = Signature::parse(pattern)?;
    let hit = scan_elf_executable(data, &sig)
        .into_iter()
        .find(|&o| o >= anchor && o < anchor.saturating_add(window));
    match hit {
        Some(off) => {
            tracing::info!("ebpf: {binary}: {what} resolved at offset {off:#x} (anchored)");
            Some(off)
        }
        None => {
            tracing::warn!(
                "ebpf: {binary}: {what} not found within {window:#x} of anchor {anchor:#x}"
            );
            None
        }
    }
}

/// Resolve a unique uprobe file offset for `pattern` in `data`. Requires
/// exactly one match: zero means a stale/wrong signature (skip, don't attach
/// blindly), and more than one is ambiguous (a too-loose signature would attach
/// the probe to the wrong function). Both cases log and return `None`.
pub(crate) fn resolve_single_offset(
    data: &[u8],
    pattern: &str,
    what: &str,
    binary: &str,
) -> Option<u64> {
    let Some(sig) = Signature::parse(pattern) else {
        tracing::warn!("ebpf: {binary}: malformed {what} signature {pattern:?}");
        return None;
    };
    let hits = scan_elf_executable(data, &sig);
    match hits.as_slice() {
        [] => {
            tracing::warn!("ebpf: {binary}: {what} signature matched nothing (wrong build?)");
            None
        }
        [off] => {
            tracing::info!("ebpf: {binary}: {what} resolved at offset {off:#x}");
            Some(*off)
        }
        many => {
            tracing::warn!(
                "ebpf: {binary}: {what} signature is ambiguous ({} matches) — refine it",
                many.len()
            );
            None
        }
    }
}

/// Does this target carry enough config to resolve uprobe offsets at all?
/// (an explicit offset, a config signature, or a flavor with built-in sigs.)
pub(crate) fn target_has_source(target: &EbpfTarget) -> bool {
    target.write_offset.is_some()
        || target.read_offset.is_some()
        || target.write_sig.is_some()
        || target.read_sig.is_some()
        || flavor_signatures(&target.flavor).is_some()
}

/// True if a `/proc/<pid>/exe` readlink target has the given basename. The
/// kernel suffixes the link with `" (deleted)"` once the binary is unlinked by
/// an auto-update, so strip that first. Matching by **basename** (not full path)
/// is what lets us re-attach across npm's atomic-rename upgrade, which stages the
/// new build in a `.<pkg>-<hash>/` dir before renaming it over the install path —
/// the running process's exe then points into that now-deleted staging dir.
pub(crate) fn exe_link_has_basename(link: &str, basename: &str) -> bool {
    let path = link.strip_suffix(" (deleted)").unwrap_or(link);
    std::path::Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        == Some(basename)
}

/// Resolve SSL_read/SSL_write **file offsets** for a target from the given
/// binary `data` (config offsets first, then config signatures, then built-in
/// flavor signatures). Pure over `data` — same bytes always yield the same
/// offsets, so a per-inode result can be cached as "seen".
pub(crate) fn resolve_target_offsets(
    data: &[u8],
    target: &EbpfTarget,
    label: &str,
) -> (Option<u64>, Option<u64>) {
    let mut read_off = target.read_offset;
    let mut write_off = target.write_offset;
    if read_off.is_some() && write_off.is_some() {
        return (read_off, write_off);
    }

    // Config-supplied signatures take precedence and must match uniquely.
    if read_off.is_none() {
        if let Some(p) = &target.read_sig {
            read_off = resolve_single_offset(data, p, "SSL_read", label);
        }
    }
    if write_off.is_none() {
        if let Some(p) = &target.write_sig {
            write_off = resolve_single_offset(data, p, "SSL_write", label);
        }
    }

    // Fall back to built-in flavor signatures: anchor on the unique SSL_read
    // prologue, then locate SSL_write (generic prologue) as the nearest match in
    // the window after it.
    if let Some(fs) = flavor_signatures(&target.flavor) {
        if read_off.is_none() {
            read_off = resolve_single_offset(data, fs.read_sig, "SSL_read", label);
        }
        if write_off.is_none() {
            match read_off {
                Some(anchor) => {
                    write_off = resolve_windowed(
                        data,
                        fs.write_sig,
                        anchor,
                        fs.write_window,
                        "SSL_write",
                        label,
                    );
                }
                None => tracing::warn!(
                    "ebpf: {label}: no SSL_read anchor — cannot locate SSL_write by window"
                ),
            }
        }
    }
    (read_off, write_off)
}

#[cfg(test)]
mod tests {
    //! These tests ran only under `--features ebpf` when the helpers lived in
    //! the Linux/aya-gated `source.rs`; hoisting them here makes the pure
    //! offset-resolution logic run (and count toward coverage) on every host
    //! without the BPF toolchain or `CAP_BPF`.

    use super::*;

    fn target(binary: &str, flavor: &str) -> EbpfTarget {
        EbpfTarget {
            binary: binary.to_string(),
            flavor: flavor.to_string(),
            write_sig: None,
            read_sig: None,
            write_offset: None,
            read_offset: None,
        }
    }

    #[test]
    fn exe_link_basename_matches_plain_path() {
        assert!(exe_link_has_basename(
            "/home/user/.nvm/.../claude-code/bin/claude.exe",
            "claude.exe"
        ));
    }

    #[test]
    fn exe_link_basename_matches_through_deleted_suffix() {
        // After an npm atomic-rename auto-update the running process's exe points
        // into the now-unlinked staging dir; the kernel appends " (deleted)".
        // Basename matching must see through both the staging dir and the suffix.
        assert!(exe_link_has_basename(
            "/home/user/.nvm/.../@anthropic-ai/.claude-code-BLnYIOGh/bin/claude.exe (deleted)",
            "claude.exe"
        ));
        assert!(exe_link_has_basename(
            "/home/user/.nvm/.../opencode-ai/bin/opencode.exe (deleted)",
            "opencode.exe"
        ));
    }

    #[test]
    fn exe_link_basename_rejects_other_binaries() {
        assert!(!exe_link_has_basename("/usr/bin/node", "claude.exe"));
        assert!(!exe_link_has_basename(
            "/some/where/claude.exe.bak (deleted)",
            "claude.exe"
        ));
    }

    #[test]
    fn target_has_source_requires_offset_sig_or_flavor() {
        // Bare boringssl flavor with no offsets/sigs → not enough to attach.
        assert!(!target_has_source(&target("/x/claude.exe", "boringssl")));
        // A known flavor with built-in signatures is enough.
        assert!(target_has_source(&target("/x/claude.exe", "bun")));
        // An explicit offset is enough regardless of flavor.
        let mut t = target("/x/claude.exe", "boringssl");
        t.read_offset = Some(0x1000);
        assert!(target_has_source(&t));
    }

    #[test]
    fn resolve_offsets_passes_config_offsets_through_without_scanning() {
        let mut t = target("/x/claude.exe", "boringssl");
        t.read_offset = Some(0x4165_5e0);
        t.write_offset = Some(0x4165_970);
        // Empty data would make any scan fail; config offsets must short-circuit.
        let (r, w) = resolve_target_offsets(&[], &t, "test");
        assert_eq!(r, Some(0x4165_5e0));
        assert_eq!(w, Some(0x4165_970));
    }

    /// A planted prologue at a known file offset is resolved by the built-in
    /// `bun` flavor's `SSL_read` signature when it is the only match — the
    /// read-anchored path the loader uses on a real stripped binary, but here
    /// built from a tiny synthetic ELF so no real Bun binary is needed.
    #[test]
    fn flavor_signature_resolves_unique_read_anchor() {
        // Reuse the sigscan ELF builder shape: a single exec PT_LOAD segment.
        let mut elf = vec![0u8; 0x200];
        elf[0..4].copy_from_slice(b"\x7fELF");
        elf[4] = 2; // 64-bit
        elf[5] = 1; // little-endian
        elf[0x20..0x28].copy_from_slice(&0x40u64.to_le_bytes()); // e_phoff
        elf[0x36..0x38].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize
        elf[0x38..0x3A].copy_from_slice(&1u16.to_le_bytes()); // e_phnum
        let ph = 0x40;
        elf[ph..ph + 4].copy_from_slice(&1u32.to_le_bytes()); // PT_LOAD
        elf[ph + 4..ph + 8].copy_from_slice(&0x1u32.to_le_bytes()); // PF_X
        elf[ph + 8..ph + 16].copy_from_slice(&0x100u64.to_le_bytes()); // p_offset
        elf[ph + 32..ph + 40].copy_from_slice(&0x80u64.to_le_bytes()); // p_filesz
        // Plant the built-in bun SSL_read prologue at file offset 0x110.
        let fs = flavor_signatures("bun").expect("bun has built-in signatures");
        let sig = Signature::parse(fs.read_sig).expect("read_sig parses");
        elf[0x110..0x110 + sig.len()].copy_from_slice(&sig.bytes);
        // `target("…", "bun")` carries no config sig/offset → resolve falls back
        // to the built-in flavor signatures (the read-anchored path).
        let t = target("/x/claude.exe", "bun");
        let (read_off, write_off) = resolve_target_offsets(&elf, &t, "test");
        assert_eq!(read_off, Some(0x110), "anchored on the unique SSL_read match");
        // No SSL_write planted in the window → write stays unresolved, not a
        // bogus offset (the loader skips a target whose write is missing).
        assert!(write_off.is_none(), "no SSL_write match → None, not a guess");
    }
}
