//! Integration tests for the read-only API surface that need a real
//! `DuckDbBackend`.
//!
//! Covers `/api/metrics/*`, `/api/spans*`, `/api/traces*`,
//! `/api/agent-sessions*`, `/api/services*`, `/api/http-exchanges*`,
//! `/api/filters/*`, `/api/agent-turns*` (deprecated alias), plus the
//! state-bearing `/api/runtime-config`, `/api/health`, and
//! `/api/internal-metrics` routes — all exercised through the full
//! `router(...)` oneshot so the route wiring (CORS, deprecation
//! middleware, state wiring) is covered too.
//!
//! Consolidated into one integration test file (one test binary) to keep
//! the `h-api` lib unit-test binary off `libduckdb-sys` without
//! multiplying the number of binaries that pay the ~50 MB DuckDB link cost
//! — each `tests/*.rs` file becomes its own binary. New DuckDB-backed
//! route tests belong HERE, not in a fresh `tests/*.rs`.

use std::net::IpAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use bytes::Bytes;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;
use h_api::{router, ApiHealthContext, ApiMetricsContext, ApiRuntimeConfigContext};
use h_llm::model::{ApiType, LlmCall};
use h_llm::wire_apis as wa;
use h_metrics::model::{LlmFinishMetric, LlmMetric};
use h_protocol::model::{HttpRequestData, HttpResponseData};
use h_protocol::net::FlowKey;
use h_protocol::HttpExchange;
use h_storage::StorageBackend;
use h_storage_duckdb::DuckDbBackend;
use h_turn::{Trace, TraceStatus};

fn test_metrics_context() -> ApiMetricsContext {
    let sys = h_common::internal_metrics::MetricsSystem::new();
    ApiMetricsContext {
        pipelines: vec![],
        global: sys.start(),
        history: None,
    }
}

fn test_runtime_config_context() -> ApiRuntimeConfigContext {
    ApiRuntimeConfigContext {
        config: std::sync::Arc::new(h_common::config::AppConfig {
            pipelines: vec![],
            storage: h_common::config::StorageConfig::default(),
            internal_metrics: h_common::config::InternalMetricsConfig::default(),
            api: h_common::config::ApiConfig::default(),
            agent_classifier: h_common::config::ClassifierConfigToml::default(),
            body_cap: h_common::config::BodyCapConfig::default(),
        }),
        config_path: "test".to_string(),
        loaded_at_ms: 0,
        version: "test",
    }
}

fn test_health_context() -> ApiHealthContext {
    ApiHealthContext {
        started_at_ms: 0,
        version: "test",
        pipelines: vec![],
        drained: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    }
}

/// Build the full router backed by an in-memory DuckDB so every read route
/// is exercised through the real wiring (CORS, deprecation middleware,
/// per-state sub-routers). Seeds `storage` via the `StorageBackend`
/// trait methods.
fn app(storage: Arc<dyn StorageBackend>) -> axum::Router {
    router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    )
}

/// Open + init an in-memory DuckDB backend. Tests are `#[tokio::test]` so
/// they `.await` this helper directly.
async fn fresh_db() -> DuckDbBackend {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as StorageBackend>::init(&backend).await.unwrap();
    backend
}

// ---- seed builders ----
//
// Minimal-but-real rows for each entity, matching the shapes the existing
// storage tests use. Fields left at `*`/zero are the ones the read paths
// under test don't join on; the tests set the relevant fields inline.

const BASE_US: i64 = 1_700_000_000_000_000;
/// `BASE_US` expressed in *seconds* — the unit the API's `start`/`end`
/// query params use (the handler multiplies by 1e6 into the µs
/// `TimeRange`).
const BASE_S: i64 = 1_700_000_000;

fn base_metric() -> LlmMetric {
    LlmMetric {
        timestamp_us: BASE_US,
        source_id: String::new(),
        granularity: "10s",
        wire_api: wa::OPENAI_CHAT.to_string(),
        model: "gpt-4".to_string(),
        server_ip: "10.0.0.2".to_string(),
        call_count: 1,
        stream_count: 0,
        non_stream_count: 1,
        active_calls_sum: 0,
        active_calls_sample_count: 0,
        active_calls_max: 0,
        total_input_tokens: 0,
        input_token_count: 0,
        total_output_tokens: 0,
        output_token_count: 0,
        total_cache_read_input_tokens: 0,
        total_cache_creation_input_tokens: 0,
        error_count: 0,
        error_4xx_count: 0,
        error_429_count: 0,
        error_5xx_count: 0,
        ttft_sum: 0.0,
        ttft_count: 0,
        ttft_p50: None,
        ttft_p95: None,
        ttft_p99: None,
        ttft_stream_sum: 0.0,
        ttft_stream_count: 0,
        ttft_stream_p50: None,
        ttft_stream_p95: None,
        ttft_stream_p99: None,
        ttft_nonstream_sum: 0.0,
        ttft_nonstream_count: 0,
        ttft_nonstream_p50: None,
        ttft_nonstream_p95: None,
        ttft_nonstream_p99: None,
        e2e_sum: 0.0,
        e2e_count: 0,
        e2e_p50: None,
        e2e_p95: None,
        e2e_p99: None,
        tpot_sum: 0.0,
        tpot_count: 0,
        tpot_p50: None,
        tpot_p95: None,
        tpot_p99: None,
        tool_surface: None,
    }
}

/// Minimal `LlmCall` (a row in `spans`). `id` is the PK the spans detail
/// route and the turn `span_ids` reference.
fn base_call(id: &str, request_time_us: i64) -> LlmCall {
    LlmCall {
        source_id: String::new(),
        id: id.to_string(),
        wire_api: wa::OPENAI_CHAT,
        model: "gpt-4".to_string(),
        api_type: ApiType::Chat,
        request_time: request_time_us,
        response_time: None,
        complete_time: None,
        request_path: "/v1/chat/completions".to_string(),
        is_stream: false,
        request_body: None,
        status_code: Some(200),
        finish_reason: Some("stop".to_string()),
        response_body: None,
        input_tokens: Some(10),
        output_tokens: Some(5),
        total_tokens: Some(15),
        cache_read_input_tokens: None,
        cache_creation_input_tokens: None,
        ttft_ms: None,
        e2e_latency_ms: None,
        client_ip: "10.0.0.1".parse::<IpAddr>().unwrap(),
        client_port: 1000,
        server_ip: "10.0.0.2".parse::<IpAddr>().unwrap(),
        server_port: 8080,
        response_id: None,
        request_headers: vec![],
        response_headers: vec![],
        is_agent_request: false,
        tool_surface: None,
        agent_topology: None,
        tool_call_count: 0,
        tool_names: vec![],
        body_bytes_dropped: 0,
        process: None,
    }
}

/// Minimal finalized `Trace` (a row in `traces`). `span_ids` links the
/// turn to its `LlmCall` rows so the `/api/traces/{id}/spans` route has
/// something to resolve.
fn base_trace(turn_id: &str, session_id: &str, start_us: i64, span_ids: Vec<String>) -> Trace {
    Trace {
        source_id: String::new(),
        turn_id: turn_id.to_string(),
        session_id: session_id.to_string(),
        wire_api: wa::OPENAI_CHAT.to_string(),
        agent_kind: "test".to_string(),
        client_ip: "127.0.0.1".parse().unwrap(),
        server_ip: "127.0.0.1".parse().unwrap(),
        start_time_us: start_us,
        end_time_us: start_us + 1_000_000,
        duration_ms: 1000,
        call_count: span_ids.len() as u32,
        models_used: vec!["gpt-4".to_string()],
        subagents_used: vec![],
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cache_read_input_tokens: 0,
        total_cache_creation_input_tokens: 0,
        total_cost_usd: None,
        status: TraceStatus::Complete,
        final_finish_reason: Some("stop".to_string()),
        user_input_preview: None,
        user_call_id: None,
        final_answer_preview: None,
        final_call_id: span_ids.first().cloned(),
        span_ids,
        metadata: serde_json::json!({}),
        tool_surfaces: vec![],
        tool_call_total: 0,
        agent_topology: None,
        suspicious_skills: vec![],
    }
}

/// `base_trace` but with a concrete `source_id` — needed for the
/// `/api/agent-sessions/{source_id}/{session_id}` routes so the path has a
/// non-empty segment AND the storage `WHERE source_id = ?` lookup matches.
fn base_trace_with_source(
    source_id: &str,
    turn_id: &str,
    session_id: &str,
    start_us: i64,
    span_ids: Vec<String>,
) -> Trace {
    let mut t = base_trace(turn_id, session_id, start_us, span_ids);
    t.source_id = source_id.to_string();
    t
}

/// Build an `HttpExchange` with a plain JSON (non-SSE) response so the
/// row round-trips with `is_sse=false` and a retained response body.
fn base_exchange(id: &str, request_time_us: i64, uri: &str, status: u16) -> HttpExchange {
    let client_ip: IpAddr = "10.0.0.1".parse().unwrap();
    let server_ip: IpAddr = "10.0.0.2".parse().unwrap();
    let request = Arc::new(HttpRequestData {
        flow_key: FlowKey::new(id.to_string(), client_ip, 54321, server_ip, 8080),
        client_addr: (client_ip, 54321),
        server_addr: (server_ip, 8080),
        method: "POST".to_string(),
        uri: uri.to_string(),
        version: 1,
        headers: vec![("content-type".into(), "application/json".into())],
        body: Bytes::from_static(br#"{"model":"gpt-4"}"#),
        timestamp_us: request_time_us,
        process: None,
    });
    let response = Arc::new(HttpResponseData {
        flow_key: request.flow_key.clone(),
        client_addr: request.client_addr,
        server_addr: request.server_addr,
        status,
        version: 1,
        headers: vec![("content-type".into(), "application/json".into())],
        body: Bytes::from_static(br#"{"choices":[]}"#),
        first_byte_timestamp_us: request_time_us + 500_000,
        complete_timestamp_us: request_time_us + 1_000_000,
        process: None,
    });
    HttpExchange {
        id: id.to_string(),
        request,
        response,
        sse_event_count: 0,
        sse_data_bytes: 0,
    }
}

/// Read a `Response` body into a parsed JSON `Value`, asserting it is the
/// `{ code, message, data }` envelope.
async fn json_envelope(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn finish_reasons_endpoint_returns_one_series_per_raw_value() {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();

    // Seed a few raw provider values at the rolled-up (*, *, *) tier so
    // a default no-filter read picks them up, in a 1m bucket. Two rows
    // per reason → asserts grouping is by finish_reason, not just timestamp.
    let ts_a: i64 = 1_700_000_000_000_000;
    let ts_b: i64 = 1_700_000_060_000_000;
    let mk = |ts: i64, reason: &str, count: u64| LlmFinishMetric {
        timestamp_us: ts,
        source_id: String::new(),
        granularity: "1m".to_string(),
        wire_api: "*".to_string(),
        model: "*".to_string(),
        server_ip: "*".to_string(),
        finish_reason: reason.to_string(),
        count,
    };
    <DuckDbBackend as h_storage::StorageBackend>::write_finish_metrics(
        &backend,
        vec![
            mk(ts_a, "end_turn", 12),
            mk(ts_a, "tool_use", 4),
            mk(ts_a, "max_tokens", 1),
            mk(ts_b, "end_turn", 7),
            mk(ts_b, "pause_turn", 2),
        ],
    )
    .await
    .unwrap();

    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    // start/end are seconds (matches existing /api/metrics/* convention).
    let start_s = (ts_a / 1_000_000) - 1;
    let end_s = (ts_b / 1_000_000) + 60;
    let uri = format!("/api/metrics/finish-reasons?start={start_s}&end={end_s}&granularity=1m");
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let series = v["data"]["series"].as_array().expect("series array");
    let names: Vec<&str> = series
        .iter()
        .map(|s| s["finish_reason"].as_str().unwrap())
        .collect();
    // ORDER BY finish_reason ASC.
    assert_eq!(
        names,
        vec!["end_turn", "max_tokens", "pause_turn", "tool_use"]
    );

    let end_turn = &series[0];
    let points = end_turn["points"].as_array().unwrap();
    assert_eq!(points.len(), 2, "end_turn should have two buckets");
    // points are [[ts_us, count], ...] ordered by ts ascending.
    assert_eq!(points[0][0].as_i64().unwrap(), ts_a);
    assert_eq!(points[0][1].as_u64().unwrap(), 12);
    assert_eq!(points[1][0].as_i64().unwrap(), ts_b);
    assert_eq!(points[1][1].as_u64().unwrap(), 7);
}

#[tokio::test]
async fn finish_reasons_endpoint_accepts_csv_wire_api_filter() {
    // Two wire_apis in the same window; CSV `?wire_api=anthropic,openai-chat`
    // must include rows from both. Series with the same finish_reason
    // across wire_apis collapse into one (SUM at the (W, M, *) tier).
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();

    let ts: i64 = 1_700_000_000_000_000;
    let mk = |wire: &str, model: &str, reason: &str, count: u64| LlmFinishMetric {
        timestamp_us: ts,
        source_id: String::new(),
        granularity: "1m".to_string(),
        wire_api: wire.to_string(),
        model: model.to_string(),
        server_ip: "*".to_string(),
        finish_reason: reason.to_string(),
        count,
    };
    <DuckDbBackend as h_storage::StorageBackend>::write_finish_metrics(
        &backend,
        vec![
            mk("anthropic", "claude-3", "end_turn", 9),
            mk("openai-chat", "gpt-4", "stop", 5),
            mk("openai-chat", "gpt-4o", "stop", 2),
            // Outside the CSV filter — must not contribute.
            mk("gemini", "gemini-pro", "stop", 100),
        ],
    )
    .await
    .unwrap();

    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    let start_s = (ts / 1_000_000) - 1;
    let end_s = (ts / 1_000_000) + 60;
    let uri = format!(
        "/api/metrics/finish-reasons?start={start_s}&end={end_s}&granularity=1m\
         &wire_api=anthropic,openai-chat"
    );
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let series = v["data"]["series"].as_array().expect("series array");

    let names: Vec<&str> = series
        .iter()
        .map(|s| s["finish_reason"].as_str().unwrap())
        .collect();
    // Both wire_apis contributed; gemini excluded.
    assert_eq!(names, vec!["end_turn", "stop"]);

    let stop = series
        .iter()
        .find(|s| s["finish_reason"] == "stop")
        .unwrap();
    let stop_points = stop["points"].as_array().unwrap();
    assert_eq!(stop_points.len(), 1);
    // openai-chat: 5 + 2 = 7. gemini's 100 must NOT be summed in.
    assert_eq!(stop_points[0][1].as_u64().unwrap(), 7);

    let end_turn = series
        .iter()
        .find(|s| s["finish_reason"] == "end_turn")
        .unwrap();
    let et_points = end_turn["points"].as_array().unwrap();
    assert_eq!(et_points.len(), 1);
    assert_eq!(et_points[0][1].as_u64().unwrap(), 9);
}

#[tokio::test]
async fn finish_reasons_endpoint_filters_by_server_ip() {
    // Per-server rows live in the (*, *, S) tier. With `?server_ip=10.0.0.1`
    // and no wire/model filter, only that server's rows should be summed.
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();

    let ts: i64 = 1_700_000_000_000_000;
    let mk = |server: &str, reason: &str, count: u64| LlmFinishMetric {
        timestamp_us: ts,
        source_id: String::new(),
        granularity: "1m".to_string(),
        wire_api: "*".to_string(),
        model: "*".to_string(),
        server_ip: server.to_string(),
        finish_reason: reason.to_string(),
        count,
    };
    <DuckDbBackend as h_storage::StorageBackend>::write_finish_metrics(
        &backend,
        vec![
            mk("10.0.0.1", "end_turn", 5),
            mk("10.0.0.1", "tool_use", 2),
            mk("10.0.0.2", "end_turn", 7),
            // Cross-server rollup — must be excluded by the IN-list filter.
            mk("*", "end_turn", 99),
        ],
    )
    .await
    .unwrap();

    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    let start_s = (ts / 1_000_000) - 1;
    let end_s = (ts / 1_000_000) + 60;
    let uri = format!(
        "/api/metrics/finish-reasons?start={start_s}&end={end_s}&granularity=1m\
         &server_ip=10.0.0.1"
    );
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let series = v["data"]["series"].as_array().expect("series array");

    let names: Vec<&str> = series
        .iter()
        .map(|s| s["finish_reason"].as_str().unwrap())
        .collect();
    // Only 10.0.0.1's reasons; 10.0.0.2's end_turn=7 and the *-rollup's 99
    // must not appear.
    assert_eq!(names, vec!["end_turn", "tool_use"]);

    let end_turn = series
        .iter()
        .find(|s| s["finish_reason"] == "end_turn")
        .unwrap();
    assert_eq!(end_turn["points"][0][1].as_u64().unwrap(), 5);
}

/// `/api/metrics/timeseries` must anchor its X-axis on the full aligned
/// `[ceil(start/gran)*gran, ..., < end)` grid, regardless of which buckets
/// actually have data. Otherwise charts on the same page (e.g. `call_count`
/// vs `ttft_avg` while calls are still in flight and have no Complete yet)
/// end up on different time grids — recharts collapses each chart's X-axis
/// to whichever sub-range it sees, and the dashboards look inconsistent.
#[tokio::test]
async fn timeseries_endpoint_backfills_full_grid_for_sparse_data() {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();

    // Aligned 1m bucket. Only one row in the middle of a 5-bucket window —
    // the other four minutes must come back as NULL placeholders, not be
    // dropped from the response.
    let ts: i64 = 1_700_000_040_000_000; // multiple of 60_000_000 us
    let row = LlmMetric {
        timestamp_us: ts + 120_000_000, // bucket 3 of 5
        source_id: String::new(),
        granularity: "1m",
        wire_api: "*".to_string(),
        model: "*".to_string(),
        server_ip: "*".to_string(),
        call_count: 7,
        stream_count: 0,
        non_stream_count: 0,
        active_calls_sum: 0,
        active_calls_sample_count: 0,
        active_calls_max: 0,
        total_input_tokens: 0,
        input_token_count: 0,
        total_output_tokens: 0,
        output_token_count: 0,
        total_cache_read_input_tokens: 0,
        total_cache_creation_input_tokens: 0,
        error_count: 0,
        error_4xx_count: 0,
        error_429_count: 0,
        error_5xx_count: 0,
        ttft_sum: 0.0,
        ttft_count: 0,
        ttft_p50: None,
        ttft_p95: None,
        ttft_p99: None,
        ttft_stream_sum: 0.0,
        ttft_stream_count: 0,
        ttft_stream_p50: None,
        ttft_stream_p95: None,
        ttft_stream_p99: None,
        ttft_nonstream_sum: 0.0,
        ttft_nonstream_count: 0,
        ttft_nonstream_p50: None,
        ttft_nonstream_p95: None,
        ttft_nonstream_p99: None,
        e2e_sum: 0.0,
        e2e_count: 0,
        e2e_p50: None,
        e2e_p95: None,
        e2e_p99: None,
        tpot_sum: 0.0,
        tpot_count: 0,
        tpot_p50: None,
        tpot_p95: None,
        tpot_p99: None,
        tool_surface: None,
    };
    <DuckDbBackend as h_storage::StorageBackend>::write_metrics(&backend, vec![row])
        .await
        .unwrap();

    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    let start_s = ts / 1_000_000;
    let end_s = start_s + 300; // 5 minutes
    let uri = format!(
        "/api/metrics/timeseries?start={start_s}&end={end_s}&granularity=1m&fields=call_count"
    );
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let timestamps = v["data"]["timestamps"].as_array().expect("timestamps");
    let ts_secs: Vec<i64> = timestamps.iter().map(|t| t.as_i64().unwrap()).collect();
    assert_eq!(
        ts_secs,
        vec![
            start_s,
            start_s + 60,
            start_s + 120,
            start_s + 180,
            start_s + 240
        ],
        "X-axis must cover the full 5-bucket grid even when only one bucket has data"
    );

    let series = v["data"]["series"].as_array().expect("series");
    assert_eq!(series.len(), 1, "one field requested");
    let values = series[0]["values"].as_array().unwrap();
    assert!(values[0].is_null());
    assert!(values[1].is_null());
    assert_eq!(values[2].as_f64().unwrap(), 7.0);
    assert!(values[3].is_null());
    assert!(values[4].is_null());
}

/// When the entire window has no data, the response still carries the full
/// X-axis grid (with empty series). Charts then render an empty time range
/// instead of "No data available", matching siblings on the same page.
#[tokio::test]
async fn timeseries_endpoint_emits_grid_when_no_rows_exist() {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();
    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    let start_s = 1_700_000_040i64;
    let end_s = start_s + 180; // 3 minutes
    let uri = format!(
        "/api/metrics/timeseries?start={start_s}&end={end_s}&granularity=1m&fields=call_count"
    );
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let ts_secs: Vec<i64> = v["data"]["timestamps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_i64().unwrap())
        .collect();
    assert_eq!(ts_secs, vec![start_s, start_s + 60, start_s + 120]);
    assert_eq!(v["data"]["series"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn finish_reasons_endpoint_rejects_invalid_granularity() {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();
    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/metrics/finish-reasons?start=0&end=1&granularity=banana")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ---------- /api/spans* (canonical) + /api/llm-calls* (deprecated alias) ----------

#[tokio::test]
async fn invalid_status_code_returns_json_envelope() {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();
    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/spans?start=0&end=1&status_code=200,abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/json"
    );
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["code"], 1001);
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains("invalid status_code: abc"),
        "message: {}",
        v["message"]
    );
}

#[tokio::test]
async fn contains_params_parse() {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();
    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/spans?start=0&end=1&client_ip=10.0.0.1&request_path=/v1/chat")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
}

/// The deprecated pre-rename aliases (`/api/llm-calls`, `/api/agent-turns`)
/// still resolve to the same handlers AND carry the RFC 8594 `Deprecation`
/// header + a `Link` to the canonical successor, so clients can detect they
/// should migrate to `/api/spans` / `/api/traces`.
#[tokio::test]
async fn deprecated_aliases_work_and_carry_deprecation_header() {
    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();
    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    for (alias, successor) in [
        ("/api/llm-calls?start=0&end=1", "</api/spans>"),
        ("/api/agent-turns?start=0&end=1", "</api/traces>"),
    ] {
        let resp = app
            .clone()
            .oneshot(Request::builder().uri(alias).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "alias {alias} must still serve");
        assert_eq!(
            resp.headers().get("deprecation").map(|v| v.to_str().unwrap()),
            Some("true"),
            "alias {alias} must carry Deprecation: true",
        );
        assert!(
            resp.headers()
                .get("link")
                .map(|v| v.to_str().unwrap().contains(successor))
                .unwrap_or(false),
            "alias {alias} Link must point at {successor}",
        );
    }
}

/// `/api/metrics/timeseries?tool_surface=...` must SUM only the rows whose
/// `tool_surface` column matches one of the CSV values, excluding other
/// surfaces. An invalid value returns 400 instead of silently degrading to
/// an empty result.
#[tokio::test]
async fn metrics_filters_by_tool_surface() {
    fn surface_row(ts_us: i64, surface: &str, call_count: u64) -> LlmMetric {
        LlmMetric {
            timestamp_us: ts_us,
            source_id: String::new(),
            granularity: "10s",
            // (*, *, *) tier — the read-path lands here when no
            // wire_api/model/server_ip filter is supplied.
            wire_api: "*".to_string(),
            model: "*".to_string(),
            server_ip: "*".to_string(),
            call_count,
            stream_count: 0,
            non_stream_count: 0,
            active_calls_sum: 0,
            active_calls_sample_count: 0,
            active_calls_max: 0,
            total_input_tokens: 0,
            input_token_count: 0,
            total_output_tokens: 0,
            output_token_count: 0,
            total_cache_read_input_tokens: 0,
            total_cache_creation_input_tokens: 0,
            error_count: 0,
            error_4xx_count: 0,
            error_429_count: 0,
            error_5xx_count: 0,
            ttft_sum: 0.0,
            ttft_count: 0,
            ttft_p50: None,
            ttft_p95: None,
            ttft_p99: None,
            ttft_stream_sum: 0.0,
            ttft_stream_count: 0,
            ttft_stream_p50: None,
            ttft_stream_p95: None,
            ttft_stream_p99: None,
            ttft_nonstream_sum: 0.0,
            ttft_nonstream_count: 0,
            ttft_nonstream_p50: None,
            ttft_nonstream_p95: None,
            ttft_nonstream_p99: None,
            e2e_sum: 0.0,
            e2e_count: 0,
            e2e_p50: None,
            e2e_p95: None,
            e2e_p99: None,
            tpot_sum: 0.0,
            tpot_count: 0,
            tpot_p50: None,
            tpot_p95: None,
            tpot_p99: None,
            tool_surface: Some(surface.to_string()),
        }
    }

    let backend = DuckDbBackend::open(":memory:").unwrap();
    <DuckDbBackend as h_storage::StorageBackend>::init(&backend)
        .await
        .unwrap();

    let ts: i64 = 1_700_000_000_000_000; // multiple of 10_000_000 us
    <DuckDbBackend as h_storage::StorageBackend>::write_metrics(
        &backend,
        vec![
            surface_row(ts, "function_call", 100),
            surface_row(ts, "mcp", 50),
            surface_row(ts, "cli", 25),
        ],
    )
    .await
    .unwrap();

    let storage: std::sync::Arc<dyn h_storage::StorageBackend> = std::sync::Arc::new(backend);
    let app = router(
        storage,
        test_metrics_context(),
        test_runtime_config_context(),
        test_health_context(),
        std::sync::Arc::new(vec![]),
        h_turn::new_active_trace_registry(),
    );

    let start_s = ts / 1_000_000;
    let end_s = start_s + 10;

    // Filter to mcp + cli — function_call's 100 calls must NOT count.
    let uri = format!(
        "/api/metrics/timeseries?start={start_s}&end={end_s}\
         &granularity=10s&fields=call_count&tool_surface=mcp,cli"
    );
    let resp = app
        .clone()
        .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let series = v["data"]["series"].as_array().expect("series");
    assert_eq!(series.len(), 1, "one field, ungrouped → one series");
    let values = series[0]["values"].as_array().unwrap();
    let total: f64 = values.iter().filter_map(|x| x.as_f64()).sum();
    assert_eq!(
        total, 75.0,
        "expected 50 (mcp) + 25 (cli), excluding function_call"
    );

    // Sanity: no filter sums all three surfaces.
    let uri_all = format!(
        "/api/metrics/timeseries?start={start_s}&end={end_s}\
         &granularity=10s&fields=call_count"
    );
    let resp_all = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&uri_all)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp_all.status(), StatusCode::OK);
    let bytes_all = resp_all.into_body().collect().await.unwrap().to_bytes();
    let v_all: Value = serde_json::from_slice(&bytes_all).unwrap();
    let total_all: f64 = v_all["data"]["series"][0]["values"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|x| x.as_f64())
        .sum();
    assert_eq!(total_all, 175.0, "no-filter must sum all three surfaces");

    // Invalid surface → 400 (matches granularity validation pattern).
    let uri_bad = format!(
        "/api/metrics/timeseries?start={start_s}&end={end_s}\
         &granularity=10s&fields=call_count&tool_surface=foo"
    );
    let resp_bad = app
        .oneshot(
            Request::builder()
                .uri(&uri_bad)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp_bad.status(), StatusCode::BAD_REQUEST);
}

// ---------- /api/metrics/timeseries pure validation branches ----------
//
// These return 400 BEFORE touching storage, so they're exercised through
// the router against an empty backend — covering the dark validation
// branches (`granularity`, `fields`, `group_by`) without seed data.

#[tokio::test]
async fn timeseries_rejects_invalid_granularity() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/metrics/timeseries?start={BASE_S}&end={}&granularity=banana&fields=call_count",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn timeseries_requires_fields() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    // `fields=` (present but empty) deserializes but `parse_csv` returns an
    // empty Vec → the `fields is required` branch returns 400.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/metrics/timeseries?start={BASE_S}&end={}&granularity=1m&fields=",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn timeseries_rejects_unknown_group_by() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/metrics/timeseries?start={BASE_S}&end={}&granularity=1m&fields=call_count&group_by=server_ip",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ===========================================================================
// /api/metrics/summary + /api/metrics/models
//
// `timeseries` + `finish-reasons` are covered above; these two sibling
// handlers were dark.
// ===========================================================================

/// `/api/metrics/summary` sums the `(*, *, *)` tier over the window and
/// returns the aggregate row as `data`.
#[tokio::test]
async fn metrics_summary_aggregates_global_tier() {
    let backend = fresh_db().await;

    let mut m1 = base_metric();
    m1.timestamp_us = BASE_US;
    m1.wire_api = "*".to_string();
    m1.model = "*".to_string();
    m1.server_ip = "*".to_string();
    m1.call_count = 100;
    m1.error_count = 5;
    m1.total_input_tokens = 10_000;
    m1.total_output_tokens = 5_000;
    m1.ttft_sum = 10_000.0;
    m1.ttft_count = 100;
    m1.e2e_sum = 50_000.0;
    m1.e2e_count = 100;

    let mut m2 = base_metric();
    m2.timestamp_us = BASE_US + 10_000_000; // +10s
    m2.granularity = "10s";
    m2.wire_api = "*".to_string();
    m2.model = "*".to_string();
    m2.server_ip = "*".to_string();
    m2.call_count = 200;
    m2.total_input_tokens = 20_000;
    m2.total_output_tokens = 10_000;

    StorageBackend::write_metrics(&backend, vec![m1, m2])
        .await
        .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/metrics/summary?start={BASE_S}&end={}", BASE_S + 30);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["code"], 0);
    assert_eq!(v["data"]["call_count"], 300);
    assert_eq!(v["data"]["error_count"], 5);
    assert_eq!(v["data"]["total_input_tokens"], 30_000);
    assert_eq!(v["data"]["total_output_tokens"], 15_000);
}

/// `/api/metrics/summary` rejects an invalid `tool_surface` value with 400
/// (the validator is shared with the timeseries handler).
#[tokio::test]
async fn metrics_summary_rejects_invalid_tool_surface() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/metrics/summary?start={BASE_S}&end={}&tool_surface=bogus",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

/// `/api/metrics/models` returns one row per `(wire_api, model)` ordered by
/// `call_count DESC` (the default sort).
#[tokio::test]
async fn metrics_models_returns_one_row_per_wire_model() {
    let backend = fresh_db().await;

    let mut gpt4 = base_metric();
    gpt4.timestamp_us = BASE_US;
    gpt4.granularity = "10s";
    gpt4.wire_api = wa::OPENAI_CHAT.to_string();
    gpt4.model = "gpt-4".to_string();
    gpt4.server_ip = "*".to_string();
    gpt4.call_count = 100;

    let mut claude = base_metric();
    claude.timestamp_us = BASE_US;
    claude.granularity = "10s";
    claude.wire_api = wa::ANTHROPIC.to_string();
    claude.model = "claude-3".to_string();
    claude.server_ip = "*".to_string();
    claude.call_count = 200;

    StorageBackend::write_metrics(&backend, vec![gpt4, claude])
        .await
        .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/metrics/models?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let models = v["data"]["models"].as_array().expect("models array");
    assert_eq!(models.len(), 2);
    // Default sort_by=call_count, sort_order=desc → claude-3 (200) first.
    assert_eq!(models[0]["model"], "claude-3");
    assert_eq!(models[0]["call_count"], 200);
    assert_eq!(models[1]["model"], "gpt-4");
    assert_eq!(models[1]["call_count"], 100);
}

// ===========================================================================
// /api/spans — canonical list (happy path) + detail (404 + round-trip).
//
// The error-path list tests live above; the happy path + detail were dark.
// ===========================================================================

#[tokio::test]
async fn spans_list_returns_seeded_rows() {
    let backend = fresh_db().await;
    StorageBackend::write_spans(
        &backend,
        vec![
            base_call("call-1", BASE_US),
            base_call("call-2", BASE_US + 1_000_000),
        ],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/spans?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["total"], 2);
    let items = v["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    // Default sort_by=request_time, sort_order=desc → call-2 first.
    assert_eq!(items[0]["id"], "call-2");
    assert_eq!(items[0]["wire_api"], "openai-chat");
    assert_eq!(items[0]["server_port"], 8080);
    assert_eq!(items[1]["id"], "call-1");
}

/// The `is_stream` multi-value parser narrows to streaming-only rows and
/// rejects an unknown token with 400 (exercising the parser branch).
#[tokio::test]
async fn spans_list_is_stream_filter_and_rejects_unknown() {
    let backend = fresh_db().await;
    let mut streaming = base_call("s1", BASE_US);
    streaming.is_stream = true;
    StorageBackend::write_spans(&backend, vec![streaming, base_call("s2", BASE_US + 1)])
        .await
        .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);

    // stream-only → just s1.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/spans?start={BASE_S}&end={}&is_stream=stream",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["total"], 1);
    assert_eq!(v["data"]["items"][0]["id"], "s1");
    assert_eq!(v["data"]["items"][0]["is_stream"], true);

    // unknown is_stream token → 400.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/spans?start={BASE_S}&end={}&is_stream=bogus",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn spans_detail_404_for_missing_id() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/spans/ghost")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let v = json_envelope(resp).await;
    assert_eq!(v["code"], 2001);
}

#[tokio::test]
async fn spans_detail_returns_row() {
    let backend = fresh_db().await;
    StorageBackend::write_spans(&backend, vec![base_call("call-x", BASE_US)])
        .await
        .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/spans/call-x")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["id"], "call-x");
    assert_eq!(v["data"]["model"], "gpt-4");
    assert_eq!(v["data"]["status_code"], 200);
}

// ===========================================================================
// /api/traces — list / detail / calls / summary / activity.
//
// The `proxy_view_tests` module in `routes/traces.rs` covers the helper
// functions; these cover the HTTP handlers (route wiring + storage path).
// ===========================================================================

#[tokio::test]
async fn traces_list_returns_seeded_turns() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![
            base_trace("t1", "sess-1", BASE_US, vec!["call-1".into()]),
            base_trace("t2", "sess-2", BASE_US + 2_000_000, vec!["call-2".into()]),
        ],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/traces?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["total"], 2);
    let items = v["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    // Default sort_by=start_time, sort_order=desc → t2 first.
    assert_eq!(items[0]["turn_id"], "t2");
    assert_eq!(items[0]["agent_kind"], "test");
    assert_eq!(items[1]["turn_id"], "t1");
}

#[tokio::test]
async fn traces_detail_404_for_missing() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/traces/ghost")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn traces_detail_returns_turn() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![base_trace("t1", "sess-1", BASE_US, vec!["call-1".into()])],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/traces/t1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["turn_id"], "t1");
    assert_eq!(v["data"]["status"], "complete");
    assert_eq!(v["data"]["final_finish_reason"], "stop");
}

/// `/api/traces/{id}/spans` resolves the turn's `span_ids` against `spans`.
/// The turn is finalized (not in the active registry) so the handler takes
/// the `query_trace_spans` branch.
#[tokio::test]
async fn traces_calls_resolves_span_ids() {
    let backend = fresh_db().await;
    StorageBackend::write_spans(&backend, vec![base_call("call-1", BASE_US)])
        .await
        .unwrap();
    StorageBackend::write_traces(
        &backend,
        vec![base_trace("t1", "sess-1", BASE_US, vec!["call-1".into()])],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/traces/t1/spans")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let items = v["data"].as_array().expect("spans array");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "call-1");
    assert_eq!(items[0]["wire_api"], "openai-chat");
    // Default (lite=0) includes bodies — the seeded call has no body, so the
    // field is null, but the lite branch itself is exercised.
    assert!(items[0]["request_body"].is_null());
}

/// `?lite=1` strips the heavy body fields (the lite branch).
#[tokio::test]
async fn traces_calls_lite_strips_bodies() {
    let backend = fresh_db().await;
    let mut call = base_call("call-1", BASE_US);
    call.request_body = Some(r#"{"prompt":"hi"}"#.to_string());
    StorageBackend::write_spans(&backend, vec![call])
        .await
        .unwrap();
    StorageBackend::write_traces(
        &backend,
        vec![base_trace("t1", "sess-1", BASE_US, vec!["call-1".into()])],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/traces/t1/spans?lite=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let items = v["data"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    // lite=1 → request_body omitted (null) even though the row has one.
    assert!(items[0]["request_body"].is_null());
    assert!(items[0]["response_body"].is_null());
}

#[tokio::test]
async fn traces_summary_returns_aggregates() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![
            base_trace("t1", "sess-1", BASE_US, vec!["c1".into()]),
            base_trace("t2", "sess-2", BASE_US + 1_000_000, vec!["c2".into()]),
        ],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/traces/summary?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let summary = v["data"]["summary"].as_array().expect("summary array");
    // Both turns share agent_kind="test" → one bucket.
    assert_eq!(summary.len(), 1);
    assert_eq!(summary[0]["agent_kind"], "test");
    assert_eq!(summary[0]["turn_count"], 2);
}

#[tokio::test]
async fn traces_activity_returns_points() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![base_trace("t1", "sess-1", BASE_US, vec!["c1".into()])],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/traces/activity?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let points = v["data"]["points"].as_array().expect("points array");
    assert!(points.iter().all(|p| p["agent_kind"] == "test"));
    assert!(
        points.iter().map(|p| p["turn_count"].as_u64().unwrap_or(0)).sum::<u64>() >= 1,
        "at least the seeded turn shows up in some bucket"
    );
}

/// `/api/traces/{id}/proxy-view` 404s for a turn with no proxy metadata
/// (the early-return branch before the member resolution loop).
#[tokio::test]
async fn traces_proxy_view_404_without_proxy_group() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![base_trace("t1", "sess-1", BASE_US, vec!["c1".into()])],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/traces/t1/proxy-view")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

/// `/api/traces/{id}/proxy-view` 404s when the turn itself doesn't exist
/// (the other early-return branch).
#[tokio::test]
async fn traces_proxy_view_404_for_missing_turn() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/traces/ghost/proxy-view")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ===========================================================================
// /api/agent-sessions — list / detail / turns.
// ===========================================================================

#[tokio::test]
async fn agent_sessions_list_returns_seeded_sessions() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![
            base_trace("t1", "sess-1", BASE_US, vec!["c1".into()]),
            base_trace("t2", "sess-2", BASE_US + 2_000_000, vec!["c2".into()]),
            base_trace("t3", "sess-1", BASE_US + 4_000_000, vec!["c3".into()]),
        ],
    )
    .await
    .unwrap();

    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/agent-sessions?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let items = v["data"]["items"].as_array().expect("sessions array");
    // Two distinct sessions (sess-1, sess-2).
    let mut ids: Vec<&str> = items.iter().map(|s| s["session_id"].as_str().unwrap()).collect();
    ids.sort();
    assert_eq!(ids, vec!["sess-1", "sess-2"]);
    // sess-1 has two turns.
    let sess1 = items.iter().find(|s| s["session_id"] == "sess-1").unwrap();
    assert_eq!(sess1["turn_count"], 2);
}

/// The session list rejects a malformed cursor with 400 (the
/// `decode_session_cursor` failure branch at the API boundary).
#[tokio::test]
async fn agent_sessions_list_rejects_bad_cursor() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/agent-sessions?start={BASE_S}&end={}&cursor=not-hex!",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn agent_sessions_detail_404_for_missing() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/agent-sessions/nope/nope")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn agent_sessions_detail_returns_aggregate() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![
            base_trace_with_source("src1", "t1", "sess-1", BASE_US, vec!["c1".into()]),
            base_trace_with_source("src1", "t2", "sess-1", BASE_US + 2_000_000, vec!["c2".into()]),
        ],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    // The path carries the concrete source_id the turns were seeded with.
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/agent-sessions/src1/sess-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["session_id"], "sess-1");
    assert_eq!(v["data"]["turn_count"], 2);
}

/// `/api/agent-sessions/{source}/{session}/turns` lists the session's turns
/// with full-text `user_input` (server-side reconstruction branch).
#[tokio::test]
async fn agent_sessions_turns_lists_session_turns() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![
            base_trace_with_source("src1", "t1", "sess-1", BASE_US, vec!["c1".into()]),
            base_trace_with_source("src1", "t2", "sess-1", BASE_US + 2_000_000, vec!["c2".into()]),
        ],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/agent-sessions/src1/sess-1/turns")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let items = v["data"]["items"].as_array().expect("turns array");
    assert_eq!(items.len(), 2);
    // Ordered by start_time DESC → t2 first.
    assert_eq!(items[0]["turn_id"], "t2");
    assert_eq!(items[1]["turn_id"], "t1");
}

/// `/api/agent-sessions/{source}/{session}/turns` rejects a bad cursor.
#[tokio::test]
async fn agent_sessions_turns_rejects_bad_cursor() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/agent-sessions/src1/sess-1/turns?cursor=zz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ===========================================================================
// /api/services + /api/services/topology — read off `spans` (llm_calls).
// ===========================================================================

#[tokio::test]
async fn services_lists_endpoints() {
    let backend = fresh_db().await;
    StorageBackend::write_spans(&backend, vec![base_call("c1", BASE_US)])
        .await
        .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/services?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let services = v["data"]["services"].as_array().expect("services array");
    assert_eq!(services.len(), 1);
    // One endpoint: (10.0.0.2, 8080).
    assert_eq!(services[0]["server_ip"], "10.0.0.2");
    assert_eq!(services[0]["server_port"], 8080);
    assert_eq!(services[0]["call_count"], 1);
}

/// An invalid `sort_by` makes the storage layer error → 500 envelope.
#[tokio::test]
async fn services_rejects_invalid_sort_by() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/services?start={BASE_S}&end={}&sort_by=banana",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let v = json_envelope(resp).await;
    assert_eq!(v["code"], 5001);
}

#[tokio::test]
async fn services_topology_returns_nodes() {
    let backend = fresh_db().await;
    StorageBackend::write_spans(&backend, vec![base_call("c1", BASE_US)])
        .await
        .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/services/topology?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let nodes = v["data"]["nodes"].as_array().expect("nodes array");
    // At least one real node for the seeded endpoint.
    assert!(nodes.iter().any(|n| n["server_ip"] == "10.0.0.2" && n["server_port"] == 8080));
    let edges = v["data"]["edges"].as_array().expect("edges array");
    assert!(edges.iter().all(|e| {
        e["kind"] == "proxy" || e["kind"] == "inferred" || e["kind"] == "client"
    }));
}

// ===========================================================================
// /api/http-exchanges — list + detail.
// ===========================================================================

#[tokio::test]
async fn http_exchanges_list_returns_seeded_rows() {
    let backend = fresh_db().await;
    StorageBackend::write_exchanges(
        &backend,
        vec![
            base_exchange("x1", BASE_US, "/v1/chat/completions", 200),
            base_exchange("x2", BASE_US + 1_000_000, "/v1/messages", 500),
        ],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let uri = format!("/api/http-exchanges?start={BASE_S}&end={}", BASE_S + 10);
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["total"], 2);
    let items = v["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    // Default sort_by=request_time, desc → x2 first.
    assert_eq!(items[0]["id"], "x2");
    assert_eq!(items[0]["status"], 500);
    assert_eq!(items[1]["id"], "x1");
    assert_eq!(items[1]["status"], 200);
    assert_eq!(items[1]["method"], "POST");
    assert_eq!(items[1]["is_sse"], false);
}

/// The status CSV filter parses as u16; a non-numeric token → 400 (the
/// `parse_csv` + parse branch shared with spans).
#[tokio::test]
async fn http_exchanges_list_rejects_non_numeric_status() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/http-exchanges?start={BASE_S}&end={}&status=abc",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

/// The `method` filter is case-insensitive (uppercased server-side); a GET
/// for `method=post` still matches the POST exchange.
#[tokio::test]
async fn http_exchanges_list_method_filter_is_case_insensitive() {
    let backend = fresh_db().await;
    StorageBackend::write_exchanges(
        &backend,
        vec![base_exchange("x1", BASE_US, "/v1/chat/completions", 200)],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/http-exchanges?start={BASE_S}&end={}&method=post",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["total"], 1);
    assert_eq!(v["data"]["items"][0]["method"], "POST");
}

#[tokio::test]
async fn http_exchanges_detail_404_for_missing() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/http-exchanges/ghost")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn http_exchanges_detail_returns_row() {
    let backend = fresh_db().await;
    StorageBackend::write_exchanges(
        &backend,
        vec![base_exchange("x1", BASE_US, "/v1/chat/completions", 200)],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/http-exchanges/x1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["id"], "x1");
    assert_eq!(v["data"]["method"], "POST");
    assert_eq!(v["data"]["uri"], "/v1/chat/completions");
    assert_eq!(v["data"]["status"], 200);
    assert_eq!(v["data"]["request_body"], r#"{"model":"gpt-4"}"#);
}

// ===========================================================================
// /api/filters/* — distinct-value dropdowns. Each reads a different table.
// ===========================================================================

#[tokio::test]
async fn filters_wire_apis_lists_distinct() {
    let backend = fresh_db().await;
    let mut m = base_metric();
    m.wire_api = wa::OPENAI_CHAT.to_string();
    m.model = "gpt-4".to_string();
    m.server_ip = "10.0.0.2".to_string();
    StorageBackend::write_metrics(&backend, vec![m]).await.unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(Request::builder().uri("/api/filters/wire-apis").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let values = v["data"]["values"].as_array().expect("values array");
    assert!(values.iter().any(|x| x == "openai-chat"));
    // The `*` rollup tier is excluded.
    assert!(values.iter().all(|x| x != "*"));
}

#[tokio::test]
async fn filters_models_lists_distinct() {
    let backend = fresh_db().await;
    let mut m = base_metric();
    m.wire_api = wa::OPENAI_CHAT.to_string();
    m.model = "gpt-4".to_string();
    m.server_ip = "10.0.0.2".to_string();
    StorageBackend::write_metrics(&backend, vec![m]).await.unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(Request::builder().uri("/api/filters/models").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let values = v["data"]["values"].as_array().expect("values array");
    assert!(values.iter().any(|x| x == "gpt-4"));
}

#[tokio::test]
async fn filters_server_ips_lists_distinct() {
    let backend = fresh_db().await;
    let mut m = base_metric();
    m.wire_api = wa::OPENAI_CHAT.to_string();
    m.model = "gpt-4".to_string();
    m.server_ip = "10.0.0.2".to_string();
    StorageBackend::write_metrics(&backend, vec![m]).await.unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(Request::builder().uri("/api/filters/server-ips").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let values = v["data"]["values"].as_array().expect("values array");
    assert!(values.iter().any(|x| x == "10.0.0.2"));
    assert!(values.iter().all(|x| x != "*"));
}

#[tokio::test]
async fn filters_agent_kinds_lists_distinct() {
    let backend = fresh_db().await;
    StorageBackend::write_traces(
        &backend,
        vec![base_trace("t1", "sess-1", BASE_US, vec!["c1".into()])],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/filters/agent-kinds?start={BASE_S}&end={}",
                    BASE_S + 10
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let values = v["data"]["values"].as_array().expect("values array");
    assert!(values.iter().any(|x| x == "test"));
}

#[tokio::test]
async fn filters_finish_reasons_lists_distinct_pairs() {
    let backend = fresh_db().await;
    let mk = |wire: &str, reason: &str| LlmFinishMetric {
        timestamp_us: BASE_US,
        source_id: String::new(),
        granularity: "1m".to_string(),
        wire_api: wire.to_string(),
        model: "*".to_string(),
        server_ip: "*".to_string(),
        finish_reason: reason.to_string(),
        count: 1,
    };
    StorageBackend::write_finish_metrics(
        &backend,
        vec![mk(wa::OPENAI_CHAT, "stop"), mk(wa::ANTHROPIC, "end_turn")],
    )
    .await
    .unwrap();
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/filters/finish-reasons")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    let pairs = v["data"]["pairs"].as_array().expect("pairs array");
    assert_eq!(pairs.len(), 2);
    // ORDER BY wire_api, finish_reason.
    assert_eq!(pairs[0]["wire_api"], "anthropic");
    assert_eq!(pairs[0]["finish_reason"], "end_turn");
    assert_eq!(pairs[1]["wire_api"], "openai-chat");
    assert_eq!(pairs[1]["finish_reason"], "stop");
}

// ===========================================================================
// `PUT /api/capture/sources` — input-validation branches only.
//
// The happy path writes the on-disk TOML then `tokio::spawn`s a self-restart
// (`execv`), which is a real side effect we can't safely trigger from a test
// binary. These tests stop at the validation guards, all of which return 400
// BEFORE any write or spawn — so the handler's input-validation line coverage
// is exercised without ever re-execing the process.
// ===========================================================================

async fn put_capture_sources(body: &str) -> axum::response::Response {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    app.oneshot(
        Request::builder()
            .method("PUT")
            .uri("/api/capture/sources")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn capture_sources_rejects_empty_pipeline_name() {
    let resp = put_capture_sources(
        r#"{"pipeline_name":"","sources":[{"type":"cloud-probe"}]}"#,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn capture_sources_rejects_empty_sources() {
    // Refuses to disarm capture — at least one source is required.
    let resp = put_capture_sources(r#"{"pipeline_name":"local","sources":[]}"#).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn capture_sources_rejects_empty_pcap_interface() {
    // A Pcap source with an empty interface fails `validate_pcap_source`
    // (no libpcap enumeration needed — the empty check is first), so this
    // returns 400 before any config write / self-restart.
    let resp = put_capture_sources(
        r#"{"pipeline_name":"local","sources":[{"type":"pcap","interface":""}]}"#,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

/// A malformed JSON body fails the `Json` extractor with a 400 — the body
/// is axum's plain-text rejection, NOT the `{code,message,data}` envelope
/// (only the custom `Query`/`Path` extractors wrap rejections into `ApiError`),
/// so we assert the status only.
#[tokio::test]
async fn capture_sources_rejects_malformed_json() {
    let resp = put_capture_sources(r#"not json"#).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ===========================================================================
// /api/runtime-config + /api/health + /api/internal-metrics via the full
// router — these have in-crate unit tests already, but routing them through
// the real `router(...)` covers the sub-router state wiring (which the
// in-crate handler-level tests don't).
// ===========================================================================

#[tokio::test]
async fn runtime_config_route_emits_config_snapshot() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(Request::builder().uri("/api/runtime-config").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["data"]["config_path"], "test");
    assert_eq!(v["data"]["version"], "test");
    // `ebpf_available` is a bool either way; just assert presence + type.
    assert!(v["data"]["ebpf_available"].is_boolean());
    assert!(v["data"]["config"].is_object());
}

#[tokio::test]
async fn health_route_via_full_router() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["code"], 0);
    assert_eq!(v["data"]["status"], "ready");
    assert_eq!(v["data"]["version"], "test");
    // No pipelines registered in the test health context.
    assert_eq!(v["data"]["pipelines"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn internal_metrics_route_via_full_router() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(Request::builder().uri("/api/internal-metrics").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["code"], 0);
    assert!(v["data"]["ts"].as_i64().unwrap() > 0);
    // Empty pipelines in the test context; the global section is present
    // (the bare `MetricsSystem` registers no probes, so the metrics array
    // is legitimately empty — what matters is the route wires through).
    assert_eq!(v["data"]["pipelines"].as_array().unwrap().len(), 0);
    assert!(v["data"]["global"]["metrics"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn internal_metrics_series_route_empty_without_history() {
    let backend = fresh_db().await;
    let storage: Arc<dyn StorageBackend> = Arc::new(backend);
    let app = app(storage);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/internal-metrics/series")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = json_envelope(resp).await;
    assert_eq!(v["code"], 0);
    // history=None → empty series.
    assert_eq!(v["data"]["series"].as_array().unwrap().len(), 0);
}

