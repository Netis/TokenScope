# `h-ebpf-prog` — BPF program for SSL-uprobe capture

The eBPF program that attaches to `SSL_read` / `SSL_write` / `SSL_shutdown` /
`SSL_free` and streams the plaintext (and connection lifecycle) to userspace
over a ring buffer as `SslEvent` records. The shared record layout lives in
[`h-ebpf-common`](../h-ebpf-common); the userspace loader is
[`h-capture`'s `ebpf` feature](../h-capture/src/ebpf). See the design notes:
[02-capture.md § eBPF](../../docs/design/02-capture.md#ebpf-ssl-uprobe-capture-linux-experimental)
and [03-ebpf-static-targets.md](../../docs/design/03-ebpf-static-targets.md).

This is a **standalone workspace** (excluded from `server/Cargo.toml`): it builds
for `bpfel-unknown-none` with a pinned nightly toolchain and `bpf-linker`, so it
must never be pulled into a host `cargo build` / `cargo test --workspace`. The
loader embeds the compiled object out-of-band via `h-capture/build.rs`.

## Inventory

### Probes (`#[uprobe]` / `#[uretprobe]` entry points)

| Program | Attach | Direction | Emits |
|---|---|---|---|
| `ssl_write` | uprobe on `SSL_write` (entry) | client→server | `DATA_WRITE` |
| `ssl_read_enter` | uprobe on `SSL_read` (entry) | — | stashes `ssl`/`buf` in `READ_ARGS` by `tid` |
| `ssl_read_exit` | uretprobe on `SSL_read` (return) | server→client | `DATA_READ` (ret>0) or `CLOSE` (ret==0, peer close_notify) |
| `ssl_shutdown` | uprobe on `SSL_shutdown` | — | `CLOSE` |
| `ssl_free` | uprobe on `SSL_free` | — | `CLOSE` (frees the `SSL*` for reuse → flow resets) |

`SSL_read` reads its buffer only on return, so entry stashes the args and the
uretprobe emits using the real byte count.

### Maps (`#[map]`)

| Map | Type | Key → Value | Max entries | Role |
|---|---|---|---|---|
| `EVENTS` | `RingBuf` | — | 16 MiB (byte size) | Carries `SslEvent` records to userspace |
| `READ_ARGS` | `HashMap` | `tid: u32` → `ReadArgs{ssl,buf}` | 10240 | `SSL_read` entry→return arg stash |
| `WRITE_OFF` | `HashMap` | `conn_id: u64` → next c2s byte offset | 10240 | Running client→server stream offset |
| `READ_OFF` | `HashMap` | `conn_id: u64` → next s2c byte offset | 10240 | Running server→client stream offset |

The two `*_OFF` maps give a large `SSL_*` call split across several events — and
successive calls on a keep-alive connection — a monotonic per-direction
position (`seq_off`), cleared on close so a reused `SSL*` pointer restarts at 0.

### Emit paths

- `emit_data(ev_kind, ssl, buf, len)` — streams one `SSL_read`/`SSL_write`
  buffer to userspace as up to `MAX_CHUNKS` (8) consecutive `DATA_CAP`-sized
  events on the same `conn_id` + direction. Each chunk is stamped with its
  absolute stream offset (`base + start`).
- `emit_chunk_at(...)` — emits ONE `DATA_CAP`-sized chunk of `buf[start..]` if
  `start < len`: reserves a `SslEvent`, fills `kind`/`pid`/`conn_id`/`ktime_ns`/
  `seq_off`/`data_len`/`comm`, `bpf_probe_read_user`s the payload, submits.
- `emit_close(ssl)` — forgets both per-connection offsets and emits one `CLOSE`.
- `stream_off` / `set_stream_off` — read/write the running offset for a
  `(conn_id, direction)`.

### Constants

- `DATA_CAP = 32_768` (from `h-ebpf-common`) — max plaintext bytes per event.
- `MAX_CHUNKS = 8` — max `DATA_CAP`-sized chunks per `SSL_*` call (a write larger
  than 256 KiB loses its tail; the userspace parser tolerates a shorter body).

## Residual BPF-only lines (NOT host-testable)

`h-ebpf-common` (the shared `SslEvent` layout) and `h-capture`'s
`ebpf/{decode,offsets,sigscan,synth}` modules are pure and host-unit-tested on
every platform. **This file is the residual**: everything in `src/main.rs` runs
only in the BPF program under the kernel verifier and cannot be extracted to
host-testable code without breaking the verifier. The reasons, line by line:

- **`emit_chunk_at` is `#[inline(always)]` and invoked from an UNROLLED
  sequence, not a loop.** A real `for` loop's back-edge makes the 5.15 BPF
  verifier reject the program ("R1 type=ctx expected=fp"), and a non-inlined
  helper becomes a BPF-to-BPF call the verifier also rejects. Inlined + unrolled,
  the body is straight-line code the verifier accepts. Extracting it to a
  callable function (host or otherwise) is therefore **not verifier-safe**.
- **`emit_data`'s body is the unrolled 8× `emit_chunk_at` call**, for the same
  reason — it is residual by construction, not oversight.
- **`stream_off` / `set_stream_off` are `#[inline(always)]`** for the same
  verifier reason (a non-inlined BPF-to-BPF call trips the 5.15 verifier). They
  are kept as the smallest straight-line read/write of the offset maps.
- **The `bpf_*` helper calls** (`bpf_probe_read_user`, `bpf_get_current_comm`,
  `bpf_ktime_get_ns`, `bpf_get_current_pid_tgid`) and the ring-buffer
  `reserve`/`submit` are BPF-only kernel APIs with no host analogue.
- **`#[panic_handler]`** is required by the `no_std` BPF target.

So this program is validated end-to-end by the **`ebpf-soak`** workflow on the
staging VM (real Bun/BoringSSL TLS → captured plaintext → persisted
process-attributed `LlmCall`), not by host unit tests. The pure contract it
relies on — the `SslEvent` layout, the decode, the offset resolution, and the
frame synthesis — *is* host-tested in `h-ebpf-common` and `h-capture`.

## Build

```sh
# From the server/ workspace — the loader's build.rs does this out-of-band when
# `--features ebpf` is on, so you rarely invoke it directly.
rustup run nightly cargo build -Z build-std=core --release \
    --target bpfel-unknown-none
```

Requires the `nightly` toolchain (with `rust-src`), the `bpfel-unknown-none`
target, and `bpf-linker` (see `rust-toolchain.toml` and `.cargo/config.toml`).
The object is embedded into `h-capture` and loaded by `EbpfSource`.
