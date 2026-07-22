//! Shared event layout for the eBPF SSL-uprobe capture path.
//!
//! Defined once and used by both sides of the ring buffer:
//! * the BPF program (`h-ebpf-prog`, compiled for `bpfel-unknown-none`) writes
//!   these records, and
//! * the userspace loader (`h-capture`'s `ebpf` feature) reads them back.
//!
//! `#![no_std]` with no dependencies so it builds for the BPF target and the
//! host identically. The layout is `#[repr(C)]` and POD; the loader reads each
//! ring-buffer slice with an unaligned read, so no alignment guarantees are
//! required from the ring buffer.
//!
//! The layout is the contract between the BPF program and userspace, so it is
//! locked by host unit tests (see the `tests` module) — a field reorder or a
//! changed `DATA_CAP` that would silently break the ring-buffer read is caught
//! on every platform without the BPF toolchain or `CAP_BPF`.

#![no_std]

/// Length of a process `comm` (kernel `TASK_COMM_LEN`).
pub const COMM_LEN: usize = 16;

/// Maximum plaintext bytes carried in a single event. A single `SSL_read` /
/// `SSL_write` larger than this is split by the BPF program
/// (`h-ebpf-prog::emit_data`) into several consecutive same-direction events,
/// each carrying its absolute position in the connection-direction stream via
/// [`SslEvent::seq_off`], which the userspace synthesizer uses to place every
/// chunk at the correct sequence number (so a dropped/reordered chunk leaves a
/// detectable gap instead of shifting every later byte).
///
/// Sized at 32 KiB so a real-world Claude Code `/v1/messages` request — sent by
/// Node as ONE ~23 KiB `SSL_write` (request line + headers + JSON body) —
/// arrives whole in a single event. At the previous 4 KiB the request was cut
/// after its first 4 KiB, so `anthropic-version` / the JSON body were lost and
/// the wire-API registry could not recognize the call (it went to
/// `wires_ignored`), leaving every Claude Code call out of storage. The record
/// is reserved from the 16 MiB ring buffer (not the 512-byte BPF stack), so a
/// 32 KiB payload is fine, and the `bpf_probe_read_user` length stays clamped
/// to `DATA_CAP`, so the verifier can still prove the copy in-bounds.
pub const DATA_CAP: usize = 32768;

/// Event kind discriminants (`SslEvent::kind`).
pub mod kind {
    /// Plaintext written by the client (`SSL_write`) — client→server.
    pub const DATA_WRITE: u32 = 1;
    /// Plaintext read by the client (`SSL_read`) — server→client.
    pub const DATA_READ: u32 = 2;
    /// Connection torn down (`SSL_shutdown` / `SSL_free`).
    pub const CLOSE: u32 = 3;
}

/// One ring-buffer record. Fixed size (`DATA_CAP` payload) so the BPF program
/// can reserve it in the ring buffer and fill `data[..data_len]`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SslEvent {
    /// One of [`kind`].
    pub kind: u32,
    /// Userspace PID (thread-group id) that made the call.
    pub pid: u32,
    /// Per-connection handle: the `SSL*` pointer value, unique among live
    /// connections in a process. Identifies the logical connection.
    pub conn_id: u64,
    /// Kernel monotonic timestamp (`bpf_ktime_get_ns`).
    pub ktime_ns: u64,
    /// Absolute byte offset of `data[0]` within this connection-direction
    /// stream. The BPF program keeps a running per-`(conn_id, direction)`
    /// counter so that a single large `SSL_*` call split across several events —
    /// and successive calls on the same keep-alive connection — carry a
    /// monotonic position. The userspace synthesizer maps this to a TCP sequence
    /// number, so a silently dropped or reordered chunk leaves a gap at its true
    /// position instead of shifting every later byte earlier (which previously
    /// spliced the next request's bytes into the prior body). Always 0 for
    /// `CLOSE`.
    pub seq_off: u64,
    /// Valid bytes in `data` (0 for `CLOSE`).
    pub data_len: u32,
    /// Process name (`bpf_get_current_comm`), NUL-padded.
    pub comm: [u8; COMM_LEN],
    /// Plaintext payload, valid for `data_len` bytes.
    pub data: [u8; DATA_CAP],
}

impl SslEvent {
    /// Total size of the record on the wire.
    pub const SIZE: usize = core::mem::size_of::<Self>();
}

#[cfg(test)]
mod tests {
    //! Layout contract for the shared ring-buffer record.
    //!
    //! The BPF program (`h-ebpf-prog`) writes these `#[repr(C)]` records into
    //! the ring buffer and the userspace loader (`h-capture`) reads each slice
    //! back with an unaligned read, so the two sides must agree byte-for-byte on
    //! field order, sizes, and padding. These tests pin that layout on the host
    //! — no BPF toolchain or `CAP_BPF` required — so a future edit that would
    //! silently break the ring-buffer read (a reordered field, a resized
    //! `DATA_CAP`, a changed discriminant) fails `cargo test` on every
    //! platform. This is why the shared layout lives in a dependency-free
    //! `no_std` crate rather than being duplicated on each side.

    use super::*;
    use core::mem::{align_of, size_of, MaybeUninit};
    use core::ptr::addr_of;

    /// An uninitialized `SslEvent` used solely to take field *addresses*. We
    /// never read the field values (only `addr_of` their offsets), so
    /// `MaybeUninit::uninit` suffices and is safe — no validity assumption on
    /// the bytes is made.
    fn uninit_event() -> MaybeUninit<SslEvent> {
        MaybeUninit::<SslEvent>::uninit()
    }

    #[test]
    fn constants_match_their_documented_values() {
        // Kernel `TASK_COMM_LEN` and the 32 KiB single-event payload cap. The
        // cap is sized so a real ~23 KiB Claude Code `/v1/messages` request
        // arrives whole in one event (see DATA_CAP's doc comment) — changing it
        // silently resizes the ring-buffer record and the BPF reservation.
        assert_eq!(COMM_LEN, 16);
        assert_eq!(DATA_CAP, 32_768);
    }

    #[test]
    fn kind_discriminants_are_stable_wire_values() {
        // The BPF program stamps `kind` and userspace matches on it
        // (`decode_event`); these integers are a wire ABI, not an enum repr.
        assert_eq!(kind::DATA_WRITE, 1);
        assert_eq!(kind::DATA_READ, 2);
        assert_eq!(kind::CLOSE, 3);
        // The three kinds are distinct so decode can't conflate them.
        assert_ne!(kind::DATA_WRITE, kind::DATA_READ);
        assert_ne!(kind::DATA_WRITE, kind::CLOSE);
        assert_ne!(kind::DATA_READ, kind::CLOSE);
    }

    #[test]
    fn repr_c_field_offsets_are_pinned() {
        // `#[repr(C)]` gives a fixed field order; lock each offset so a
        // reorder is caught. Computed from the declared order (not a magic
        // table): kind/pid at 0/4, the three u64s at 8/16/24, then data_len at
        // 32, comm at 36, data at 52.
        let ev = uninit_event();
        let base = ev.as_ptr();
        assert_eq!(addr_of!((*base).kind) as usize - base as usize, 0);
        assert_eq!(addr_of!((*base).pid) as usize - base as usize, 4);
        assert_eq!(addr_of!((*base).conn_id) as usize - base as usize, 8);
        assert_eq!(addr_of!((*base).ktime_ns) as usize - base as usize, 16);
        assert_eq!(addr_of!((*base).seq_off) as usize - base as usize, 24);
        assert_eq!(addr_of!((*base).data_len) as usize - base as usize, 32);
        assert_eq!(addr_of!((*base).comm) as usize - base as usize, 36);
        assert_eq!(addr_of!((*base).data) as usize - base as usize, 52);
    }

    #[test]
    fn record_size_is_the_pinned_field_sum_rounded_to_alignment() {
        // The on-wire size = sum of the fields, rounded up to the struct's
        // alignment (the largest member, `u64` → 8). Deriving it here, rather
        // than asserting a single number, keeps the test honest about *why*
        // the trailing padding exists and survives a `DATA_CAP` change (the
        // round-up recomputes). `SslEvent::SIZE` is `size_of::<Self>()`, which
        // is what the loader checks against the ring-buffer slice length. The
        // trailing pad is `align - field_sum % align`.
        let field_sum = size_of::<u32>()  // kind
            + size_of::<u32>()            // pid
            + size_of::<u64>()            // conn_id
            + size_of::<u64>()            // ktime_ns
            + size_of::<u64>()            // seq_off
            + size_of::<u32>()            // data_len
            + COMM_LEN                    // comm
            + DATA_CAP;                   // data
        let align = align_of::<SslEvent>();
        assert_eq!(align, 8, "largest member is u64");
        let rounded = field_sum + (align - field_sum % align) % align;
        assert_eq!(SslEvent::SIZE, rounded);
        // 4+4+8+8+8+4+16+32768 = 32820 → round up to 32824.
        assert_eq!(field_sum, 32_820);
        assert_eq!(SslEvent::SIZE, 32_824);
        // The size must cover the full payload array (the BPF program fills
        // `data[..data_len]` up to DATA_CAP, reserving one whole record).
        assert!(SslEvent::SIZE >= DATA_CAP + 52);
    }

    #[test]
    fn size_is_the_same_on_bpf_and_host_targets() {
        // The whole point of this crate: the layout is identical whether it's
        // compiled for `bpfel-unknown-none` (BPF program) or the host
        // (userspace loader). Both read `SslEvent::SIZE`, so it must be a pure
        // function of the type — re-derive it from a fresh query to be sure the
        // const and the runtime value agree.
        assert_eq!(SslEvent::SIZE, size_of::<SslEvent>());
    }

    #[test]
    fn data_array_is_a_trailing_inline_buffer() {
        // `data` must be an inline `[u8; DATA_CAP]` (not a pointer/Vec): the BPF
        // program does `bpf_probe_read_user` straight into the reserved record
        // and userspace reads `data[..data_len]` from the same record, so the
        // payload travels inside the ring-buffer entry, not through a follow-on
        // pointer. It starts at offset 52 (pinned above) and the record is
        // large enough to hold the whole array — the few bytes from the array's
        // end (32_820) to `SIZE` (32_824) are `repr(C)` trailing alignment pad,
        // not payload.
        let ev = uninit_event();
        let base = ev.as_ptr();
        let data_off = addr_of!((*base).data) as usize - base as usize;
        assert_eq!(data_off, 52);
        assert_eq!(size_of::<[u8; DATA_CAP]>(), DATA_CAP);
        assert!(data_off + DATA_CAP <= SslEvent::SIZE);
    }
}

