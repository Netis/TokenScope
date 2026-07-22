//! Decode the eBPF ring-buffer record into the cross-platform [`SslEvent`].
//!
//! This is the userspace half of the contract that `h-ebpf-common` pins from
//! the BPF side: a `SslEvent` (`#[repr(C)]`, POD) arrives as an unaligned byte
//! slice in the ring buffer, and [`decode_event`] reads it back into the
//! [`crate::ebpf::SslEvent`] the pump consumes. It is pure over the input
//! bytes — no kernel, no aya, no tokio — so the decode logic (and its
//! direction mapping, `data_len` clamping, NUL-trimmed `comm`, best-effort
//! `/proc/<pid>/exe` attribution) is unit-tested on every host without the BPF
//! toolchain or `CAP_BPF`. The Linux-only loader feeds it real ring-buffer
//! slices; tests feed it hand-built records.

use std::collections::HashMap;

use bytes::Bytes;

use h_ebpf_common::{kind, SslEvent as RawSslEvent, DATA_CAP};

use crate::ebpf::SslEvent;
use crate::synth::StreamDir;

/// Cap on the pid→exe memo so a long capture across heavy pid churn can't grow
/// it without bound. Cleared wholesale on overflow (cheap; re-warms on demand).
pub(crate) const EXE_CACHE_CAP: usize = 4096;

/// Decode one ring-buffer record into a cross-platform [`SslEvent`].
///
/// Returns `None` for a short slice or an unknown `kind` (the loader drops the
/// record and bumps `EbpfEventsDropped`). `data_len` is clamped to `DATA_CAP` so
/// a corrupt/garbage record can't index past the inline payload array.
//
// `clippy::cast_ptr_alignment`: the ring buffer hands an unaligned `&[u8]`
// slice; the cast to the POD record is deliberate and paired with
// `read_unaligned` (never a ref/deref), so the higher-alignment cast is safe.
#[allow(clippy::cast_ptr_alignment)]
pub(crate) fn decode_event(
    bytes: &[u8],
    exe_cache: &mut HashMap<u32, Option<String>>,
) -> Option<SslEvent> {
    if bytes.len() < RawSslEvent::SIZE {
        return None;
    }
    // The ring buffer gives an unaligned slice; read the POD struct unaligned.
    let raw: RawSslEvent = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const RawSslEvent) };
    let comm = comm_to_string(&raw.comm);
    match raw.kind {
        kind::CLOSE => Some(SslEvent::Close {
            conn_id: raw.conn_id,
            ktime_ns: raw.ktime_ns,
        }),
        kind::DATA_WRITE | kind::DATA_READ => {
            let len = (raw.data_len as usize).min(DATA_CAP);
            let dir = if raw.kind == kind::DATA_WRITE {
                StreamDir::ClientToServer
            } else {
                StreamDir::ServerToClient
            };
            Some(SslEvent::Data {
                conn_id: raw.conn_id,
                pid: raw.pid,
                comm,
                exe: resolve_exe(raw.pid, exe_cache),
                dir,
                data: Bytes::copy_from_slice(&raw.data[..len]),
                seq_off: raw.seq_off,
                ktime_ns: raw.ktime_ns,
            })
        }
        _ => None,
    }
}

/// Best-effort `/proc/<pid>/exe` resolution, memoized. Returns the absolute
/// executable path, or `None` when the link can't be read (process exited,
/// permission denied, or a platform with no `/proc`). Requires the capturing
/// process to out-rank the target — satisfied when running as root /
/// CAP_SYS_PTRACE, which the eBPF source needs anyway.
pub(crate) fn resolve_exe(pid: u32, cache: &mut HashMap<u32, Option<String>>) -> Option<String> {
    if let Some(v) = cache.get(&pid) {
        return v.clone();
    }
    if cache.len() >= EXE_CACHE_CAP {
        cache.clear();
    }
    // `/proc/<pid>/exe` is Linux-only; on a platform without `/proc` the
    // readlink fails and we get `None`, which is the correct "no attribution"
    // result. (Cross-platform callers use it for the decode contract; the live
    // loader only runs on Linux where `/proc` exists.)
    let resolved = std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    cache.insert(pid, resolved.clone());
    resolved
}

/// A kernel `comm` (`bpf_get_current_comm`) is NUL-padded; trim to the first
/// NUL (or the whole field if none), lossy over non-UTF-8.
pub(crate) fn comm_to_string(comm: &[u8]) -> String {
    let end = comm.iter().position(|&b| b == 0).unwrap_or(comm.len());
    String::from_utf8_lossy(&comm[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    //! Decode contract: bytes → `SslEvent`. These run on every host (no aya,
    //! no `CAP_BPF`), pinning the direction mapping, `data_len` clamp, comm
    //! NUL-trim, and short-record rejection the live loader depends on.

    use super::*;

    /// A `SslEvent` record with `data_len` valid bytes in the inline payload,
    /// serialized into a byte vec the way the ring buffer hands it to the
    /// loader. Built from an aligned stack value then copied out with
    /// `write_unaligned` — mirroring the loader's `read_unaligned` — so the
    /// test never performs a misaligned field write (UB) through the buffer.
    fn raw_record(kind: u32, pid: u32, conn_id: u64, comm: &[u8], data: &[u8]) -> Vec<u8> {
        raw_record_len(kind, pid, conn_id, comm, data, data.len() as u32)
    }

    /// Same as [`raw_record`] but with an explicit, possibly forged `data_len`
    /// (used to assert the decoder clamps a record that claims more payload than
    /// the inline array holds).
    #[allow(clippy::cast_ptr_alignment)] // deliberate unaligned write (mirrors decode)
    fn raw_record_len(
        kind: u32,
        pid: u32,
        conn_id: u64,
        comm: &[u8],
        data: &[u8],
        data_len: u32,
    ) -> Vec<u8> {
        let mut raw = RawSslEvent {
            kind,
            pid,
            conn_id,
            ktime_ns: 1_000_000,
            seq_off: 0,
            data_len,
            comm: [0; h_ebpf_common::COMM_LEN],
            data: [0; DATA_CAP],
        };
        let n = comm.len().min(h_ebpf_common::COMM_LEN);
        raw.comm[..n].copy_from_slice(&comm[..n]);
        let m = data.len().min(DATA_CAP);
        raw.data[..m].copy_from_slice(&data[..m]);
        let mut bytes = vec![0u8; RawSslEvent::SIZE];
        unsafe { std::ptr::write_unaligned(bytes.as_mut_ptr() as *mut RawSslEvent, raw) };
        bytes
    }

    #[test]
    fn close_event_decodes_without_payload_or_pid() {
        let mut cache = HashMap::new();
        let bytes = raw_record(kind::CLOSE, 0, 42, b"", &[]);
        let ev = decode_event(&bytes, &mut cache).expect("CLOSE decodes");
        match ev {
            SslEvent::Close { conn_id, ktime_ns } => {
                assert_eq!(conn_id, 42);
                assert_eq!(ktime_ns, 1_000_000);
            }
            other => panic!("expected Close, got {other:?}"),
        }
    }

    #[test]
    fn write_event_maps_to_client_to_server_with_seq_off_and_data() {
        let mut cache = HashMap::new();
        let payload = b"POST /v1/messages HTTP/1.1\r\n\r\n";
        let bytes = raw_record(kind::DATA_WRITE, 4242, 7, b"node\0", payload);
        let ev = decode_event(&bytes, &mut cache).expect("DATA_WRITE decodes");
        match ev {
            SslEvent::Data {
                conn_id,
                pid,
                comm,
                dir,
                data,
                seq_off,
                ..
            } => {
                assert_eq!(conn_id, 7);
                assert_eq!(pid, 4242);
                assert_eq!(comm, "node");
                assert_eq!(dir, StreamDir::ClientToServer);
                assert_eq!(&data[..], payload);
                assert_eq!(seq_off, 0);
            }
            other => panic!("expected Data, got {other:?}"),
        }
    }

    #[test]
    fn read_event_maps_to_server_to_client() {
        let mut cache = HashMap::new();
        let payload = b"HTTP/1.1 200 OK\r\n\r\n";
        let bytes = raw_record(kind::DATA_READ, 1, 9, b"curl\0\0", payload);
        let ev = decode_event(&bytes, &mut cache).expect("DATA_READ decodes");
        match ev {
            SslEvent::Data { dir, comm, .. } => {
                assert_eq!(dir, StreamDir::ServerToClient);
                assert_eq!(comm, "curl");
            }
            other => panic!("expected Data, got {other:?}"),
        }
    }

    #[test]
    fn data_len_clamped_to_data_cap_on_a_garbage_record() {
        // A record claiming more bytes than DATA_CAP must not index past the
        // inline array. With data_len = u32::MAX, decode clamps to DATA_CAP and
        // copies only the (zero-filled) payload bytes — no out-of-bounds read.
        let mut cache = HashMap::new();
        let bytes = raw_record_len(kind::DATA_WRITE, 1, 1, b"x", &[0u8; 8], u32::MAX);
        let ev = decode_event(&bytes, &mut cache).expect("clamps, not rejects");
        match ev {
            SslEvent::Data { data, .. } => assert_eq!(data.len(), DATA_CAP),
            other => panic!("expected Data, got {other:?}"),
        }
    }

    #[test]
    fn short_record_is_rejected() {
        let mut cache = HashMap::new();
        // One byte short of a full record → no decode (the loader drops it).
        let mut bytes = raw_record(kind::CLOSE, 0, 1, b"", &[]);
        bytes.pop();
        assert!(decode_event(&bytes, &mut cache).is_none());
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let mut cache = HashMap::new();
        let bytes = raw_record(99, 0, 1, b"", &[]);
        assert!(decode_event(&bytes, &mut cache).is_none());
    }

    #[test]
    fn comm_is_nul_trimmed_and_lossy() {
        let mut cache = HashMap::new();
        // "node" then a NUL then padding — only "node" survives, and a
        // non-UTF-8 byte elsewhere would be lossy (validated by from_utf8_lossy).
        let comm = b"node\0garbage";
        let bytes = raw_record(kind::DATA_WRITE, 1, 1, comm, b"hi");
        let ev = decode_event(&bytes, &mut cache).expect("decodes");
        match ev {
            SslEvent::Data { comm, .. } => assert_eq!(comm, "node"),
            other => panic!("expected Data, got {other:?}"),
        }
    }

    #[test]
    fn resolve_exe_memoizes_and_caches_none_on_failure() {
        // PID 0 is never a real process; readlink fails (or `/proc` is absent)
        // → None, cached so the lookup isn't retried per event.
        let mut cache = HashMap::new();
        assert!(resolve_exe(0, &mut cache).is_none());
        assert!(cache.contains_key(&0), "the None is cached");
        // Second call hits the cache (no new syscall), still None.
        assert!(resolve_exe(0, &mut cache).is_none());
    }

    #[test]
    fn exe_cache_clears_wholesale_on_overflow() {
        let mut cache = HashMap::new();
        // Fill to the cap with distinct pids so the next insert trips the cap.
        for pid in 1..=EXE_CACHE_CAP {
            cache.insert(pid as u32, None);
        }
        assert_eq!(cache.len(), EXE_CACHE_CAP);
        resolve_exe(EXE_CACHE_CAP as u32 + 1, &mut cache);
        // The overflow path clears the whole map then re-inserts the one pid.
        assert!(cache.len() <= 2, "cleared on overflow, not grown past cap");
        assert!(cache.contains_key(&(EXE_CACHE_CAP as u32 + 1)));
    }
}
