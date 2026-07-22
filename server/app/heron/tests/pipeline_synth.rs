//! Pipeline E2E driven by SYNTHESIZED pcaps — no privileged capture required.
//!
//! The existing `pipeline_e2e.rs` skips when its gitignored pcap fixtures are
//! absent, so it contributes nothing to CI coverage of the composition root.
//! This test builds the pcap fixtures **on the fly** from `FlowSynthesizer`
//! frames (the same pure, cross-platform synthesizer that backs eBPF capture),
//! writes them as real pcap files, runs them through `Pipeline::build`, and
//! asserts the three storage tables populate with the expected wire APIs.
//!
//! That exercises the full wiring — dispatcher → protocol → llm → turn →
//! metrics → shared storage sink — end to end on every CI run, with no
//! CAP_NET_RAW/root and no binary fixture checked in.

use std::path::PathBuf;

use duckdb::Connection;
use h_capture::{
    CaptureSource, ConnTuple, FlowSynthesizer, PcapFileSource, StreamDir, SynthConfig,
};
use h_common::config::{
    CaptureSourceConfig, DuckDbConfig, PipelineDef, RetentionConfig, StorageConfig,
    StorageSinkConfig,
};
use h_common::internal_metrics::{Metric, MetricsSystem};
use h_llm::wire_apis as wa;
use heron::create_backend;
use heron::Pipeline;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

/// pcap global header (little-endian, magic 0xa1b2c3d4) + one record per
/// `RawPacket`. Link type 1 = Ethernet, which is what `FlowSynthesizer`
/// stamps on every frame (`LINKTYPE_ETHERNET`).
fn write_pcap(path: &std::path::Path, packets: &[h_capture::RawPacket]) {
    let mut buf: Vec<u8> = Vec::with_capacity(24 + packets.len() * 64);
    // Global header.
    buf.extend_from_slice(&0xa1b2c3d4u32.to_le_bytes()); // magic
    buf.extend_from_slice(&2u16.to_le_bytes()); // version major
    buf.extend_from_slice(&4u16.to_le_bytes()); // version minor
    buf.extend_from_slice(&0i32.to_le_bytes()); // thiszone
    buf.extend_from_slice(&0u32.to_le_bytes()); // sigfigs
    buf.extend_from_slice(&65535u32.to_le_bytes()); // snaplen
    buf.extend_from_slice(&1u32.to_le_bytes()); // link type (Ethernet)
    for p in packets {
        let ts_sec = (p.timestamp_us / 1_000_000) as u32;
        let ts_usec = (p.timestamp_us % 1_000_000) as u32;
        buf.extend_from_slice(&ts_sec.to_le_bytes());
        buf.extend_from_slice(&ts_usec.to_le_bytes());
        buf.extend_from_slice(&(p.caplen as u32).to_le_bytes());
        buf.extend_from_slice(&(p.wirelen as u32).to_le_bytes());
        buf.extend_from_slice(&p.data);
    }
    std::fs::write(path, &buf).expect("write synth pcap");
}

/// A complete, minimal Anthropic Messages exchange as synthetic TCP frames.
/// Non-streaming JSON response with a `usage` block so token accounting lands
/// in `spans` and the metrics stage emits a row.
fn anthropic_frames(source_id: &str, conn_id: u64, ts_base_us: i64) -> Vec<h_capture::RawPacket> {
    let mut s = FlowSynthesizer::new(SynthConfig {
        source_id: source_id.to_string(),
        ..SynthConfig::default()
    });
    let tuple = ConnTuple {
        client: "203.0.113.4:51000".parse().unwrap(),
        server: "192.0.2.10:443".parse().unwrap(),
    };
    let req_body = r#"{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}"#;
    let req = format!(
        "POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n\
         x-api-key: sk-ant-test-key\r\nanthropic-version: 2023-06-01\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{req_body}",
        req_body.len()
    );
    let resp_body = r#"{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-6","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":10,"output_tokens":5}}"#;
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{resp_body}",
        resp_body.len()
    );

    let mut frames = s.open(conn_id, tuple, ts_base_us);
    frames.extend(s.data(
        conn_id,
        StreamDir::ClientToServer,
        req.as_bytes(),
        0,
        ts_base_us + 1000,
    ));
    frames.extend(s.data(
        conn_id,
        StreamDir::ServerToClient,
        resp.as_bytes(),
        0,
        ts_base_us + 2000,
    ));
    frames.extend(s.close(conn_id, ts_base_us + 3000));
    frames
}

/// A complete, minimal OpenAI Responses exchange (Codex-style). `POST
/// /v1/responses` with `Authorization: Bearer`, body `{model, input}` (no
/// `messages`), and a non-streaming `status: "completed"` response with
/// `usage`.
fn openai_responses_frames(
    source_id: &str,
    conn_id: u64,
    ts_base_us: i64,
) -> Vec<h_capture::RawPacket> {
    let mut s = FlowSynthesizer::new(SynthConfig {
        source_id: source_id.to_string(),
        ..SynthConfig::default()
    });
    // Distinct 5-tuple from the anthropic connection so flow keys don't collide.
    let tuple = ConnTuple {
        client: "198.51.100.7:52000".parse().unwrap(),
        server: "192.0.2.20:443".parse().unwrap(),
    };
    let req_body = r#"{"model":"codex-1","input":[{"type":"message","role":"user","content":"hi"}]}"#;
    let req = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: api.openai.com\r\n\
         Authorization: Bearer sk-test-key\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n\r\n{req_body}",
        req_body.len()
    );
    let resp_body = r#"{"id":"resp_01","status":"completed","model":"codex-1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}"#;
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{resp_body}",
        resp_body.len()
    );

    let mut frames = s.open(conn_id, tuple, ts_base_us);
    frames.extend(s.data(
        conn_id,
        StreamDir::ClientToServer,
        req.as_bytes(),
        0,
        ts_base_us + 1000,
    ));
    frames.extend(s.data(
        conn_id,
        StreamDir::ServerToClient,
        resp.as_bytes(),
        0,
        ts_base_us + 2000,
    ));
    frames.extend(s.close(conn_id, ts_base_us + 3000));
    frames
}

fn build_storage_config(db_path: &str) -> StorageConfig {
    StorageConfig {
        backend: "duckdb".into(),
        duckdb: DuckDbConfig {
            path: db_path.into(),
        },
        sink: StorageSinkConfig::default(),
        retention: RetentionConfig::default(),
        ..Default::default()
    }
}

/// Run `pcap_specs` (synth-generated pcap + pipeline name) through the full
/// pipeline into an on-disk DuckDB. Each spec becomes its own pipeline (so
/// flow keys / turn state stay isolated) fanning into the shared storage
/// sink. Returns the temp dir + db path so the caller can verify.
async fn run_synth_pipeline(
    pcap_specs: &[(&str, PathBuf, Vec<h_capture::RawPacket>)],
) -> (TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("synth.duckdb");
    let storage_config = build_storage_config(&db_path.to_string_lossy());

    let storage = create_backend(&storage_config).expect("create backend");
    storage.init().await.expect("init storage");

    // Write each synth pcap to disk and build a one-source pipeline per file.
    let pipeline_defs: Vec<PipelineDef> = pcap_specs
        .iter()
        .map(|(name, path, frames)| {
            write_pcap(path, frames);
            PipelineDef {
                name: (*name).to_string(),
                sources: vec![CaptureSourceConfig::PcapFile {
                    path: path.to_string_lossy().to_string(),
                    realtime: false,
                    source_id: None,
                    loop_count: 1,
                    loop_secs: 0,
                    rate_pps: 0,
                }],
                ..PipelineDef::default()
            }
        })
        .collect();

    let mut per_pipeline_metrics: Vec<MetricsSystem> = (0..pipeline_defs.len())
        .map(|_| MetricsSystem::new())
        .collect();
    let mut shared_metrics = MetricsSystem::new();

    // Register capture metrics for each pipeline's single source.
    let capture_metrics: Vec<_> = per_pipeline_metrics
        .iter_mut()
        .enumerate()
        .map(|(i, sys)| {
            sys.register_worker(
                &format!("capture.synth.{i}"),
                &[
                    Metric::CapturePacketsReceived,
                    Metric::CaptureKernelPacketsDropped,
                    Metric::CaptureTruncatedPackets,
                ],
            )
        })
        .collect();

    let sink_config = h_storage::StorageSinkConfig {
        batch_size: storage_config.sink.batch_size,
        flush_interval_ms: storage_config.sink.flush_interval_ms,
    };

    let Pipeline {
        pipeline_txs,
        pipeline_sources: _,
        stage_handles,
    } = Pipeline::build(
        &pipeline_defs,
        &sink_config,
        storage.clone(),
        &mut per_pipeline_metrics,
        &mut shared_metrics,
        h_turn::new_active_trace_registry(),
        h_llm::agent_classifier::ClassifierConfig::default(),
        h_common::config::BodyCapConfig::default(),
    );
    let _metrics_svcs: Vec<_> = per_pipeline_metrics.into_iter().map(|s| s.start()).collect();
    let _shared_metrics_svc = shared_metrics.start();

    // Each pcap source owns its pipeline's sender; EOF cascades down on drop.
    let mut src_tasks = Vec::new();
    for ((path, (_name, tx)), metrics) in pcap_specs
        .iter()
        .map(|(_, p, _)| p.clone())
        .zip(pipeline_txs.into_iter())
        .zip(capture_metrics.into_iter())
    {
        let cancel = CancellationToken::new();
        src_tasks.push(tokio::spawn(async move {
            let source_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();
            let source = Box::new(PcapFileSource::new(path, source_id, None));
            let _ = source.run(tx, metrics, cancel).await;
        }));
    }
    for t in src_tasks {
        t.await.expect("synth pcap source task panicked");
    }
    // Await every stage that drains on EOF (dispatcher → … → storage_sink).
    // The pair_sweeper is a long-lived background loop (sleep + sweep, forever,
    // holding its own `Arc<StorageBackend>`) — awaiting it would hang, so we
    // detach it here and explicitly abort it once the draining stages are done.
    // (`pipeline_e2e.rs` skips without fixtures so this latent issue is masked
    // there; our synth pcaps always run, so we must not await the sweeper.)
    for (task, h) in stage_handles {
        if task.stage == "pair_sweeper" {
            h.abort();
            // A tokio task that has been aborted yields a JoinError (Cancelled)
            // when awaited; await it to reap and ignore.
            let _ = h.await;
        } else {
            h.await
                .unwrap_or_else(|e| panic!("stage '{task}' panicked: {e}"));
        }
    }
    drop(storage);
    (tmp, db_path)
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or_else(|e| panic!("count {table}: {e}"))
}

fn distinct_wire_apis(conn: &Connection, table: &str) -> Vec<String> {
    conn.prepare(&format!("SELECT DISTINCT wire_api FROM {table} ORDER BY 1"))
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// A single anthropic synth pcap must populate all three tables and extract
/// a complete `spans` row with the right model / path / tokens — the
/// same ground truth `pipeline_e2e.rs` asserts against the binary fixture,
/// now driven by generated bytes so it runs unconditionally.
#[tokio::test]
async fn synth_anthropic_pcap_populates_all_three_tables() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pcap_path = dir.path().join("claude-synth.pcap");
    let frames = anthropic_frames("claude-synth", 1, 1_700_000_000_000_000);

    // Keep the temp dir holding the pcap alive across the run.
    let (_tmp, db_path) =
        run_synth_pipeline(&[("claude", pcap_path, frames)]).await;

    let conn = Connection::open(&db_path).expect("reopen duckdb");
    let calls = count(&conn, "spans");
    let turns = count(&conn, "traces");
    let metrics = count(&conn, "llm_metrics");
    assert!(calls >= 1, "expected >=1 spans, got {calls}");
    assert!(turns >= 1, "expected >=1 traces, got {turns}");
    assert!(metrics >= 1, "expected >=1 llm_metrics, got {metrics}");

    let wire_apis = distinct_wire_apis(&conn, "spans");
    assert!(
        wire_apis.iter().any(|w| w == wa::ANTHROPIC),
        "expected anthropic in spans wire_apis, got {wire_apis:?}"
    );

    // The synthesized response carried input=10 / output=5; the span row must
    // reflect that extraction end-to-end.
    let (model, path, status, in_t, out_t): (String, String, Option<u16>, Option<u32>, Option<u32>) =
        conn.query_row(
            "SELECT model, request_path, status_code, input_tokens, output_tokens \
             FROM spans WHERE wire_api = 'anthropic' LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .expect("anthropic span row");
    assert_eq!(model, "claude-sonnet-4-6");
    assert_eq!(path, "/v1/messages");
    assert_eq!(status, Some(200));
    assert_eq!(in_t, Some(10));
    assert_eq!(out_t, Some(5));

    // Metrics must have at least one anthropic 10s bucket — proves the
    // llm stage → metrics shard → shared sink wiring.
    let anthropic_10s: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(call_count), 0) FROM llm_metrics \
             WHERE granularity = '10s' AND wire_api = 'anthropic'",
            [],
            |r| r.get(0),
        )
        .expect("metrics sum");
    assert!(anthropic_10s >= 1, "expected >=1 anthropic 10s metric, got {anthropic_10s}");

    drop(conn);
    drop(dir);
}

/// Two synth pcaps (anthropic + openai-responses) through two pipelines in
/// parallel: both wire APIs land in `spans`, and each produces its own
/// complete turn — proves per-pipeline isolation + the shared sink fan-in
/// without any binary fixture.
#[tokio::test]
async fn synth_two_pipelines_isolated_metrics_merged() {
    let dir = tempfile::tempdir().expect("tempdir");
    let anthropic_path = dir.path().join("claude-synth.pcap");
    let openai_path = dir.path().join("codex-synth.pcap");
    let anthropic = anthropic_frames("claude-synth", 1, 1_700_000_000_000_000);
    let openai = openai_responses_frames("codex-synth", 2, 1_700_000_000_000_000);

    let specs = [
        ("claude", anthropic_path, anthropic),
        ("codex", openai_path, openai),
    ];
    let (_tmp, db_path) = run_synth_pipeline(&specs).await;

    let conn = Connection::open(&db_path).expect("reopen duckdb");

    let span_apis = distinct_wire_apis(&conn, "spans");
    assert!(
        span_apis.iter().any(|w| w == wa::ANTHROPIC),
        "expected anthropic in spans, got {span_apis:?}"
    );
    assert!(
        span_apis.iter().any(|w| w == wa::OPENAI_RESPONSES),
        "expected openai-responses in spans, got {span_apis:?}"
    );

    // Each pipeline produced its own turn (≥1 each) — proves neither
    // sub-pipeline starved the other and turn state didn't leak.
    let anthropic_turns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM traces WHERE wire_api = 'anthropic' AND status = 'complete'",
            [],
            |r| r.get(0),
        )
        .expect("anthropic turn count");
    assert!(anthropic_turns >= 1, "anthropic pipeline produced a turn");
    let openai_turns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM traces WHERE wire_api = 'openai-responses'",
            [],
            |r| r.get(0),
        )
        .expect("openai turn count");
    assert!(openai_turns >= 1, "openai-responses pipeline produced a turn");

    // Per-source metrics: both wire APIs appear in llm_metrics, each emitted
    // by its own source_id (the pcap basename).
    let metric_apis = distinct_wire_apis(&conn, "llm_metrics");
    assert!(metric_apis.iter().any(|w| w == wa::ANTHROPIC));
    assert!(metric_apis.iter().any(|w| w == wa::OPENAI_RESPONSES));

    let source_ids: Vec<String> = conn
        .prepare("SELECT DISTINCT source_id FROM llm_metrics ORDER BY 1")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(source_ids.len(), 2, "expected 2 source_ids, got {source_ids:?}");
    assert!(source_ids.iter().any(|s| s == "claude-synth"));
    assert!(source_ids.iter().any(|s| s == "codex-synth"));

    drop(conn);
    drop(dir);
}

/// A pcap with no LLM-shaped traffic must drain cleanly and leave all three
/// tables empty — guards against the pipeline inventing rows from noise and
/// proves the EOF cascade still terminates with nothing to write.
#[tokio::test]
async fn synth_non_llm_pcap_drains_with_empty_tables() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pcap_path = dir.path().join("noise.pcap");
    // A single TCP segment carrying plain text (not an HTTP request) — the
    // HTTP parser / wire-API detector never accepts it, so no LlmCall is
    // extracted. We synthesize via FlowSynthesizer so the frame decodes.
    let mut s = FlowSynthesizer::new(SynthConfig {
        source_id: "noise".to_string(),
        ..SynthConfig::default()
    });
    let tuple = ConnTuple {
        client: "203.0.113.9:53000".parse().unwrap(),
        server: "192.0.2.30:80".parse().unwrap(),
    };
    let mut frames = s.open(7, tuple, 1_700_000_000_000_000);
    frames.extend(s.data(
        7,
        StreamDir::ClientToServer,
        b"not an http request just bytes",
        0,
        1_700_000_000_000_000 + 1000,
    ));
    frames.extend(s.data(
        7,
        StreamDir::ServerToClient,
        b"nor is this a response",
        0,
        1_700_000_000_000_000 + 2000,
    ));
    frames.extend(s.close(7, 1_700_000_000_000_000 + 3000));

    let (_tmp, db_path) = run_synth_pipeline(&[("noise", pcap_path, frames)]).await;
    let conn = Connection::open(&db_path).expect("reopen duckdb");
    assert_eq!(count(&conn, "spans"), 0, "no LLM traffic → no spans");
    assert_eq!(count(&conn, "traces"), 0, "no LLM traffic → no traces");
    assert_eq!(count(&conn, "llm_metrics"), 0, "no LLM traffic → no metrics");
    drop(conn);
    drop(dir);
}
