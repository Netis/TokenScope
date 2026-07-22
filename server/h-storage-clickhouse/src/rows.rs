//! `#[derive(clickhouse::Row)]` structs for INSERT (and full-row SELECT where
//! needed). Field **names** map to ClickHouse columns and field **order**
//! matches the `CREATE TABLE` column order — RowBinary is positional on SELECT
//! and the insert column list is generated from the struct fields, so both must
//! line up with `schema.rs`.
//!
//! Timestamps are `i64` microseconds (the `clickhouse` crate maps `i64`
//! directly to `DateTime64(6)` ticks; `Option<i64>` to `Nullable(DateTime64)`).
//! `From` impls mirror the DuckDB `prepare_*` functions 1:1.

use clickhouse::Row;
use serde::{Deserialize, Serialize};

use h_llm::model::LlmCall;
use h_metrics::model::{LlmFinishMetric, LlmMetric};
use h_protocol::HttpExchange;
use h_turn::Trace;

use h_storage::convert::headers_to_json;

#[derive(Row, Serialize, Deserialize)]
pub(crate) struct CallRow {
    pub id: String,
    pub source_id: String,
    pub client_ip: String,
    pub client_port: u16,
    pub server_ip: String,
    pub server_port: u16,
    pub request_time: i64,
    pub response_time: Option<i64>,
    pub complete_time: Option<i64>,
    pub wire_api: String,
    pub model: String,
    pub api_type: String,
    pub is_stream: bool,
    pub request_path: String,
    pub status_code: Option<u16>,
    pub finish_reason: Option<String>,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
    pub cache_read_input_tokens: Option<u32>,
    pub cache_creation_input_tokens: Option<u32>,
    pub ttft_ms: Option<f64>,
    pub e2e_latency_ms: Option<f64>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub response_id: Option<String>,
    pub request_headers: String,
    pub response_headers: String,
    pub is_agent_request: bool,
    pub tool_surface: Option<String>,
    pub agent_topology: Option<String>,
    pub tool_call_count: u32,
    pub tool_names_json: Option<String>,
    pub body_bytes_dropped: u64,
    pub process_pid: Option<u32>,
    pub process_comm: Option<String>,
    pub process_exe: Option<String>,
    /// OTel span kind. Every wire-captured span is an LLM call today; the
    /// column is forward-looking for wire-visible tool spans. Tail field to
    /// match the `spans` table column order (and the DuckDB layout).
    pub kind: String,
}

impl From<LlmCall> for CallRow {
    fn from(c: LlmCall) -> Self {
        CallRow {
            id: c.id,
            source_id: c.source_id,
            client_ip: c.client_ip.to_string(),
            client_port: c.client_port,
            server_ip: c.server_ip.to_string(),
            server_port: c.server_port,
            request_time: c.request_time,
            response_time: c.response_time,
            complete_time: c.complete_time,
            wire_api: c.wire_api.to_string(),
            model: c.model,
            api_type: c.api_type.to_string(),
            is_stream: c.is_stream,
            request_path: c.request_path,
            status_code: c.status_code,
            finish_reason: c.finish_reason,
            input_tokens: c.input_tokens,
            output_tokens: c.output_tokens,
            total_tokens: c.total_tokens,
            cache_read_input_tokens: c.cache_read_input_tokens,
            cache_creation_input_tokens: c.cache_creation_input_tokens,
            ttft_ms: c.ttft_ms,
            e2e_latency_ms: c.e2e_latency_ms,
            request_body: c.request_body,
            response_body: c.response_body,
            response_id: c.response_id,
            request_headers: headers_to_json(&c.request_headers),
            response_headers: headers_to_json(&c.response_headers),
            is_agent_request: c.is_agent_request,
            tool_surface: c.tool_surface.map(|s| s.to_string()),
            agent_topology: c.agent_topology.map(|s| s.to_string()),
            tool_call_count: c.tool_call_count,
            tool_names_json: Some(
                serde_json::to_string(&c.tool_names).unwrap_or_else(|_| "[]".to_string()),
            ),
            body_bytes_dropped: c.body_bytes_dropped,
            process_pid: c.process.as_ref().map(|p| p.pid),
            process_comm: c.process.as_ref().map(|p| p.comm.clone()),
            process_exe: c.process.as_ref().and_then(|p| p.exe.clone()),
            kind: "llm".into(),
        }
    }
}

#[derive(Row, Serialize, Deserialize)]
pub(crate) struct MetricRow {
    pub timestamp: i64,
    pub source_id: String,
    pub granularity: String,
    pub wire_api: String,
    pub model: String,
    pub server_ip: String,
    pub call_count: u64,
    pub stream_count: u64,
    pub non_stream_count: u64,
    pub active_calls_sum: u64,
    pub active_calls_sample_count: u64,
    pub active_calls_max: u32,
    pub total_input_tokens: u64,
    pub input_token_count: u64,
    pub total_output_tokens: u64,
    pub output_token_count: u64,
    pub total_cache_read_input_tokens: u64,
    pub total_cache_creation_input_tokens: u64,
    pub error_count: u64,
    pub error_4xx_count: u64,
    pub error_429_count: u64,
    pub error_5xx_count: u64,
    pub ttft_sum: f64,
    pub ttft_count: u64,
    pub ttft_p50: Option<f64>,
    pub ttft_p95: Option<f64>,
    pub ttft_p99: Option<f64>,
    pub ttft_stream_sum: f64,
    pub ttft_stream_count: u64,
    pub ttft_stream_p50: Option<f64>,
    pub ttft_stream_p95: Option<f64>,
    pub ttft_stream_p99: Option<f64>,
    pub ttft_nonstream_sum: f64,
    pub ttft_nonstream_count: u64,
    pub ttft_nonstream_p50: Option<f64>,
    pub ttft_nonstream_p95: Option<f64>,
    pub ttft_nonstream_p99: Option<f64>,
    pub e2e_sum: f64,
    pub e2e_count: u64,
    pub e2e_p50: Option<f64>,
    pub e2e_p95: Option<f64>,
    pub e2e_p99: Option<f64>,
    pub tpot_sum: f64,
    pub tpot_count: u64,
    pub tpot_p50: Option<f64>,
    pub tpot_p95: Option<f64>,
    pub tpot_p99: Option<f64>,
    pub tool_surface: Option<String>,
}

impl From<LlmMetric> for MetricRow {
    fn from(m: LlmMetric) -> Self {
        MetricRow {
            timestamp: m.timestamp_us,
            source_id: m.source_id,
            granularity: m.granularity.to_string(),
            wire_api: m.wire_api,
            model: m.model,
            server_ip: m.server_ip,
            call_count: m.call_count,
            stream_count: m.stream_count,
            non_stream_count: m.non_stream_count,
            active_calls_sum: m.active_calls_sum,
            active_calls_sample_count: m.active_calls_sample_count,
            active_calls_max: m.active_calls_max,
            total_input_tokens: m.total_input_tokens,
            input_token_count: m.input_token_count,
            total_output_tokens: m.total_output_tokens,
            output_token_count: m.output_token_count,
            total_cache_read_input_tokens: m.total_cache_read_input_tokens,
            total_cache_creation_input_tokens: m.total_cache_creation_input_tokens,
            error_count: m.error_count,
            error_4xx_count: m.error_4xx_count,
            error_429_count: m.error_429_count,
            error_5xx_count: m.error_5xx_count,
            ttft_sum: m.ttft_sum,
            ttft_count: m.ttft_count,
            ttft_p50: m.ttft_p50,
            ttft_p95: m.ttft_p95,
            ttft_p99: m.ttft_p99,
            ttft_stream_sum: m.ttft_stream_sum,
            ttft_stream_count: m.ttft_stream_count,
            ttft_stream_p50: m.ttft_stream_p50,
            ttft_stream_p95: m.ttft_stream_p95,
            ttft_stream_p99: m.ttft_stream_p99,
            ttft_nonstream_sum: m.ttft_nonstream_sum,
            ttft_nonstream_count: m.ttft_nonstream_count,
            ttft_nonstream_p50: m.ttft_nonstream_p50,
            ttft_nonstream_p95: m.ttft_nonstream_p95,
            ttft_nonstream_p99: m.ttft_nonstream_p99,
            e2e_sum: m.e2e_sum,
            e2e_count: m.e2e_count,
            e2e_p50: m.e2e_p50,
            e2e_p95: m.e2e_p95,
            e2e_p99: m.e2e_p99,
            tpot_sum: m.tpot_sum,
            tpot_count: m.tpot_count,
            tpot_p50: m.tpot_p50,
            tpot_p95: m.tpot_p95,
            tpot_p99: m.tpot_p99,
            tool_surface: m.tool_surface,
        }
    }
}

#[derive(Row, Serialize, Deserialize)]
pub(crate) struct FinishMetricRow {
    pub timestamp: i64,
    pub source_id: String,
    pub granularity: String,
    pub wire_api: String,
    pub model: String,
    pub server_ip: String,
    pub finish_reason: String,
    pub count: u64,
}

impl From<LlmFinishMetric> for FinishMetricRow {
    fn from(m: LlmFinishMetric) -> Self {
        FinishMetricRow {
            timestamp: m.timestamp_us,
            source_id: m.source_id,
            granularity: m.granularity,
            wire_api: m.wire_api,
            model: m.model,
            server_ip: m.server_ip,
            finish_reason: m.finish_reason,
            count: m.count,
        }
    }
}

#[derive(Row, Serialize, Deserialize)]
pub(crate) struct TurnRow {
    pub turn_id: String,
    pub source_id: String,
    pub session_id: String,
    pub wire_api: String,
    pub agent_kind: String,
    pub client_ip: String,
    pub server_ip: String,
    pub start_time: i64,
    pub end_time: i64,
    pub duration_ms: u64,
    pub call_count: u32,
    pub models_used: Option<String>,
    pub subagents_used: Option<String>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_input_tokens: u64,
    pub total_cache_creation_input_tokens: u64,
    pub total_cost_usd: Option<f64>,
    pub status: String,
    pub final_finish_reason: Option<String>,
    pub user_input_preview: Option<String>,
    pub user_call_id: Option<String>,
    pub final_answer_preview: Option<String>,
    pub final_call_id: Option<String>,
    // Maps to the `span_ids` column (RowBinary insert names columns by field).
    pub span_ids: String,
    pub metadata: Option<String>,
    pub tool_surfaces_json: Option<String>,
    pub tool_call_total: u32,
    pub agent_topology: Option<String>,
    pub suspicious_skills_json: Option<String>,
    pub _version: u64,
}

impl From<Trace> for TurnRow {
    fn from(t: Trace) -> Self {
        let tool_surfaces_json = {
            let strings: Vec<String> = t.tool_surfaces.iter().map(|s| s.to_string()).collect();
            serde_json::to_string(&strings).unwrap_or_else(|_| "[]".to_string())
        };
        let suspicious_skills_json =
            serde_json::to_string(&t.suspicious_skills).unwrap_or_else(|_| "[]".to_string());
        // Initial finalize version = end_time (micros). `update_trace_metadata`
        // re-inserts with a strictly-greater wall-clock-micros version so the
        // ReplacingMergeTree keeps the latest metadata.
        let version = t.end_time_us.max(0) as u64;
        TurnRow {
            turn_id: t.turn_id,
            source_id: t.source_id,
            session_id: t.session_id,
            wire_api: t.wire_api,
            agent_kind: t.agent_kind,
            client_ip: t.client_ip.to_string(),
            server_ip: t.server_ip.to_string(),
            start_time: t.start_time_us,
            end_time: t.end_time_us,
            duration_ms: t.duration_ms,
            call_count: t.call_count,
            models_used: Some(serde_json::to_string(&t.models_used).unwrap_or_default()),
            subagents_used: Some(serde_json::to_string(&t.subagents_used).unwrap_or_default()),
            total_input_tokens: t.total_input_tokens,
            total_output_tokens: t.total_output_tokens,
            total_cache_read_input_tokens: t.total_cache_read_input_tokens,
            total_cache_creation_input_tokens: t.total_cache_creation_input_tokens,
            total_cost_usd: t.total_cost_usd,
            status: t.status.to_string(),
            final_finish_reason: t.final_finish_reason,
            user_input_preview: t.user_input_preview,
            user_call_id: t.user_call_id,
            final_answer_preview: t.final_answer_preview,
            final_call_id: t.final_call_id,
            span_ids: serde_json::to_string(&t.span_ids).unwrap_or_default(),
            metadata: Some(t.metadata.to_string()),
            tool_surfaces_json: Some(tool_surfaces_json),
            tool_call_total: t.tool_call_total,
            agent_topology: t.agent_topology.map(|top| top.to_string()),
            suspicious_skills_json: Some(suspicious_skills_json),
            _version: version,
        }
    }
}

#[derive(Row, Serialize, Deserialize)]
pub(crate) struct ExchangeRow {
    pub id: String,
    pub source_id: String,
    pub client_ip: String,
    pub client_port: u16,
    pub server_ip: String,
    pub server_port: u16,
    pub method: String,
    pub uri: String,
    pub request_headers: String,
    pub request_body: Option<String>,
    pub status: Option<u16>,
    pub response_headers: String,
    pub response_body: Option<String>,
    pub is_sse: bool,
    pub sse_event_count: u32,
    pub sse_data_bytes: u64,
    pub request_time: i64,
    pub response_first_byte_time: Option<i64>,
    pub response_complete_time: Option<i64>,
}

impl From<HttpExchange> for ExchangeRow {
    fn from(x: HttpExchange) -> Self {
        let (client_ip, client_port) = x.client_addr();
        let (server_ip, server_port) = x.server_addr();
        let is_sse = x.is_sse();
        // ClickHouse String is byte-safe, but the 0.15 RowBinary validator maps
        // the column to a serde `str`; binary (gzip/protobuf) bodies are stored
        // lossily as UTF-8. LLM HTTP traffic here is post-TLS plaintext
        // JSON/SSE, so this is a rare edge. See module docs / 07-schema.md.
        let response_body = x
            .stored_response_body()
            .map(|b| String::from_utf8_lossy(b).into_owned());
        let request_body = if x.request.body.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&x.request.body).into_owned())
        };
        ExchangeRow {
            id: x.id.clone(),
            source_id: x.request.flow_key.source_id.clone(),
            client_ip: client_ip.to_string(),
            client_port,
            server_ip: server_ip.to_string(),
            server_port,
            method: x.request.method.clone(),
            uri: x.request.uri.clone(),
            request_headers: headers_to_json(&x.request.headers),
            request_body,
            status: Some(x.response.status),
            response_headers: headers_to_json(&x.response.headers),
            response_body,
            is_sse,
            sse_event_count: x.sse_event_count,
            sse_data_bytes: x.sse_data_bytes,
            request_time: x.request.timestamp_us,
            response_first_byte_time: Some(x.response.first_byte_timestamp_us),
            response_complete_time: Some(x.response.complete_timestamp_us),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use h_common::agent::{AgentTopology, ToolSurface};
    use h_common::process::ProcessInfo;
    use h_llm::model::ApiType;
    use h_llm::wire_apis as wa;
    use h_metrics::model::{LlmFinishMetric, LlmMetric};
    use h_protocol::HttpExchange;
    use h_turn::{Trace, TraceStatus};
    use std::net::IpAddr;

    /// Minimal `LlmCall` with non-default scalar fields set so every `CallRow`
    /// mapping branch is exercised. Mirrors the shape used by the live IT
    /// fixtures but kept local to this module.
    fn sample_call(id: &str) -> LlmCall {
        LlmCall {
            source_id: "src-0".into(),
            id: id.into(),
            wire_api: wa::OPENAI_CHAT,
            model: "gpt-4".into(),
            api_type: ApiType::Chat,
            request_time: 1_700_000_000_000_000,
            response_time: Some(1_700_000_000_500_000),
            complete_time: Some(1_700_000_001_000_000),
            request_path: "/v1/chat/completions".into(),
            is_stream: true,
            request_body: Some(r#"{"model":"gpt-4"}"#.into()),
            status_code: Some(200),
            finish_reason: Some("stop".into()),
            response_body: Some(r#"{"choices":[]}"#.into()),
            input_tokens: Some(100),
            output_tokens: Some(50),
            total_tokens: Some(150),
            cache_read_input_tokens: Some(10),
            cache_creation_input_tokens: Some(20),
            ttft_ms: Some(500.0),
            e2e_latency_ms: Some(1000.0),
            client_ip: "10.0.0.1".parse::<IpAddr>().unwrap(),
            client_port: 54321,
            server_ip: "10.0.0.2".parse::<IpAddr>().unwrap(),
            server_port: 8080,
            response_id: Some("chatcmpl-x".into()),
            request_headers: vec![("content-type".into(), "application/json".into())],
            response_headers: vec![("x-request-id".into(), "abc".into())],
            is_agent_request: true,
            tool_surface: Some(ToolSurface::Mcp),
            agent_topology: Some(AgentTopology::Orchestrator),
            tool_call_count: 3,
            tool_names: vec!["bash".into(), "grep".into()],
            body_bytes_dropped: 0,
            process: Some(ProcessInfo::new(42, "node")),
        }
    }

    #[test]
    fn call_row_from_llm_call_maps_scalars_and_stringified_ips() {
        let row = CallRow::from(sample_call("call-1"));
        assert_eq!(row.id, "call-1");
        assert_eq!(row.source_id, "src-0");
        assert_eq!(row.client_ip, "10.0.0.1");
        assert_eq!(row.client_port, 54321);
        assert_eq!(row.server_ip, "10.0.0.2");
        assert_eq!(row.server_port, 8080);
        assert_eq!(row.request_time, 1_700_000_000_000_000);
        assert_eq!(row.response_time, Some(1_700_000_000_500_000));
        assert_eq!(row.complete_time, Some(1_700_000_001_000_000));
        assert_eq!(row.wire_api, "openai-chat");
        assert_eq!(row.model, "gpt-4");
        assert_eq!(row.api_type, "chat");
        assert!(row.is_stream);
        assert_eq!(row.request_path, "/v1/chat/completions");
        assert_eq!(row.status_code, Some(200));
        assert_eq!(row.finish_reason.as_deref(), Some("stop"));
        assert_eq!(row.input_tokens, Some(100));
        assert_eq!(row.output_tokens, Some(50));
        assert_eq!(row.total_tokens, Some(150));
        assert_eq!(row.cache_read_input_tokens, Some(10));
        assert_eq!(row.cache_creation_input_tokens, Some(20));
        assert_eq!(row.ttft_ms, Some(500.0));
        assert_eq!(row.e2e_latency_ms, Some(1000.0));
        assert_eq!(row.request_body.as_deref(), Some(r#"{"model":"gpt-4"}"#));
        assert_eq!(row.response_body.as_deref(), Some(r#"{"choices":[]}"#));
        assert_eq!(row.response_id.as_deref(), Some("chatcmpl-x"));
        assert!(row.is_agent_request);
        assert_eq!(row.tool_call_count, 3);
        assert_eq!(row.body_bytes_dropped, 0);
        assert_eq!(row.process_pid, Some(42));
        assert_eq!(row.process_comm.as_deref(), Some("node"));
        assert_eq!(row.process_exe, None); // ProcessInfo::new leaves exe None
        assert_eq!(row.kind, "llm");
    }

    #[test]
    fn call_row_headers_are_json_pair_arrays() {
        let row = CallRow::from(sample_call("c"));
        let req: serde_json::Value = serde_json::from_str(&row.request_headers).unwrap();
        assert!(req.is_array());
        assert_eq!(req[0][0], "content-type");
        assert_eq!(req[0][1], "application/json");
        let resp: serde_json::Value = serde_json::from_str(&row.response_headers).unwrap();
        assert_eq!(resp[0][0], "x-request-id");
        assert_eq!(resp[0][1], "abc");
    }

    #[test]
    fn call_row_tool_names_and_surface_and_topology_serialized() {
        let row = CallRow::from(sample_call("c"));
        let names: Vec<String> = serde_json::from_str(row.tool_names_json.as_deref().unwrap()).unwrap();
        assert_eq!(names, vec!["bash".to_string(), "grep".to_string()]);
        assert_eq!(row.tool_surface.as_deref(), Some("mcp"));
        assert_eq!(row.agent_topology.as_deref(), Some("orchestrator"));
    }

    #[test]
    fn call_row_from_empty_tool_names_yields_json_array() {
        let mut c = sample_call("c");
        c.tool_names = vec![];
        let row = CallRow::from(c);
        assert_eq!(row.tool_names_json.as_deref(), Some("[]"));
    }

    #[test]
    fn call_row_passive_tap_has_no_process() {
        let mut c = sample_call("c");
        c.process = None;
        let row = CallRow::from(c);
        assert_eq!(row.process_pid, None);
        assert_eq!(row.process_comm, None);
        assert_eq!(row.process_exe, None);
    }

    fn sample_metric() -> LlmMetric {
        LlmMetric {
            timestamp_us: 1_700_000_000_000_000,
            source_id: "src-0".into(),
            granularity: "1m",
            wire_api: "openai-chat".into(),
            model: "gpt-4".into(),
            server_ip: "10.0.0.2".into(),
            call_count: 5,
            stream_count: 3,
            non_stream_count: 2,
            active_calls_sum: 7,
            active_calls_sample_count: 4,
            active_calls_max: 9,
            total_input_tokens: 100,
            input_token_count: 5,
            total_output_tokens: 50,
            output_token_count: 5,
            total_cache_read_input_tokens: 10,
            total_cache_creation_input_tokens: 20,
            error_count: 1,
            error_4xx_count: 1,
            error_429_count: 1,
            error_5xx_count: 0,
            ttft_sum: 2500.0,
            ttft_count: 5,
            ttft_p50: Some(400.0),
            ttft_p95: Some(600.0),
            ttft_p99: Some(900.0),
            ttft_stream_sum: 2000.0,
            ttft_stream_count: 4,
            ttft_stream_p50: Some(400.0),
            ttft_stream_p95: Some(500.0),
            ttft_stream_p99: Some(550.0),
            ttft_nonstream_sum: 500.0,
            ttft_nonstream_count: 1,
            ttft_nonstream_p50: Some(500.0),
            ttft_nonstream_p95: None,
            ttft_nonstream_p99: None,
            e2e_sum: 5000.0,
            e2e_count: 5,
            e2e_p50: Some(800.0),
            e2e_p95: Some(1200.0),
            e2e_p99: Some(2000.0),
            tpot_sum: 50.0,
            tpot_count: 5,
            tpot_p50: Some(10.0),
            tpot_p95: Some(12.0),
            tpot_p99: Some(15.0),
            tool_surface: Some("cli".into()),
        }
    }

    #[test]
    fn metric_row_from_llm_metric_is_field_for_field() {
        let row = MetricRow::from(sample_metric());
        assert_eq!(row.timestamp, 1_700_000_000_000_000);
        assert_eq!(row.source_id, "src-0");
        assert_eq!(row.granularity, "1m");
        assert_eq!(row.wire_api, "openai-chat");
        assert_eq!(row.model, "gpt-4");
        assert_eq!(row.server_ip, "10.0.0.2");
        assert_eq!(row.call_count, 5);
        assert_eq!(row.stream_count, 3);
        assert_eq!(row.non_stream_count, 2);
        assert_eq!(row.active_calls_sum, 7);
        assert_eq!(row.active_calls_sample_count, 4);
        assert_eq!(row.active_calls_max, 9);
        assert_eq!(row.total_input_tokens, 100);
        assert_eq!(row.input_token_count, 5);
        assert_eq!(row.total_output_tokens, 50);
        assert_eq!(row.output_token_count, 5);
        assert_eq!(row.total_cache_read_input_tokens, 10);
        assert_eq!(row.total_cache_creation_input_tokens, 20);
        assert_eq!(row.error_count, 1);
        assert_eq!(row.error_4xx_count, 1);
        assert_eq!(row.error_429_count, 1);
        assert_eq!(row.error_5xx_count, 0);
        assert_eq!(row.ttft_sum, 2500.0);
        assert_eq!(row.ttft_count, 5);
        assert_eq!(row.ttft_p50, Some(400.0));
        assert_eq!(row.ttft_p95, Some(600.0));
        assert_eq!(row.ttft_p99, Some(900.0));
        assert_eq!(row.ttft_stream_sum, 2000.0);
        assert_eq!(row.ttft_stream_count, 4);
        assert_eq!(row.e2e_sum, 5000.0);
        assert_eq!(row.e2e_count, 5);
        assert_eq!(row.e2e_p99, Some(2000.0));
        assert_eq!(row.tpot_sum, 50.0);
        assert_eq!(row.tpot_count, 5);
        assert_eq!(row.tpot_p95, Some(12.0));
        // None percentiles must pass through as None (nullable columns).
        assert_eq!(row.ttft_nonstream_p95, None);
        assert_eq!(row.ttft_nonstream_p99, None);
        assert_eq!(row.tool_surface.as_deref(), Some("cli"));
    }

    #[test]
    fn finish_metric_row_from_llm_finish_metric() {
        let m = LlmFinishMetric {
            timestamp_us: 1_700_000_000_000_000,
            source_id: "src-0".into(),
            granularity: "1m".into(),
            wire_api: "openai-chat".into(),
            model: "gpt-4".into(),
            server_ip: "10.0.0.2".into(),
            finish_reason: "stop".into(),
            count: 7,
        };
        let row = FinishMetricRow::from(m);
        assert_eq!(row.timestamp, 1_700_000_000_000_000);
        assert_eq!(row.source_id, "src-0");
        assert_eq!(row.granularity, "1m");
        assert_eq!(row.wire_api, "openai-chat");
        assert_eq!(row.model, "gpt-4");
        assert_eq!(row.server_ip, "10.0.0.2");
        assert_eq!(row.finish_reason, "stop");
        assert_eq!(row.count, 7);
    }

    fn sample_turn(end_time_us: i64) -> Trace {
        Trace {
            source_id: "src-0".into(),
            turn_id: "turn-1".into(),
            session_id: "sess-1".into(),
            wire_api: "openai-chat".into(),
            agent_kind: "claude-cli".into(),
            client_ip: "10.0.0.1".parse().unwrap(),
            server_ip: "10.0.0.2".parse().unwrap(),
            start_time_us: end_time_us - 5_000_000,
            end_time_us,
            duration_ms: 5_000,
            call_count: 2,
            models_used: vec!["gpt-4".into()],
            subagents_used: vec!["task".into()],
            total_input_tokens: 100,
            total_output_tokens: 50,
            total_cache_read_input_tokens: 10,
            total_cache_creation_input_tokens: 20,
            total_cost_usd: Some(0.0123),
            status: TraceStatus::Complete,
            final_finish_reason: Some("stop".into()),
            user_input_preview: Some("hello".into()),
            user_call_id: Some("c1".into()),
            final_answer_preview: Some("world".into()),
            final_call_id: Some("c2".into()),
            span_ids: vec!["c1".into(), "c2".into()],
            metadata: serde_json::json!({"k": "v"}),
            tool_surfaces: vec![ToolSurface::Mcp, ToolSurface::Cli],
            tool_call_total: 4,
            agent_topology: Some(AgentTopology::SubAgent),
            suspicious_skills: vec![h_turn::SuspiciousSkillRollup {
                tool_name: "bash".into(),
                reason: "shell".into(),
            }],
        }
    }

    #[test]
    fn turn_row_from_trace_serializes_json_columns() {
        let end = 1_700_000_001_000_000_i64;
        let row = TurnRow::from(sample_turn(end));
        assert_eq!(row.turn_id, "turn-1");
        assert_eq!(row.source_id, "src-0");
        assert_eq!(row.session_id, "sess-1");
        assert_eq!(row.wire_api, "openai-chat");
        assert_eq!(row.agent_kind, "claude-cli");
        assert_eq!(row.client_ip, "10.0.0.1");
        assert_eq!(row.server_ip, "10.0.0.2");
        assert_eq!(row.start_time, end - 5_000_000);
        assert_eq!(row.end_time, end);
        assert_eq!(row.duration_ms, 5_000);
        assert_eq!(row.call_count, 2);
        assert_eq!(row.total_input_tokens, 100);
        assert_eq!(row.total_output_tokens, 50);
        assert_eq!(row.total_cache_read_input_tokens, 10);
        assert_eq!(row.total_cache_creation_input_tokens, 20);
        assert_eq!(row.total_cost_usd, Some(0.0123));
        assert_eq!(row.status, "complete");
        assert_eq!(row.final_finish_reason.as_deref(), Some("stop"));
        assert_eq!(row.user_input_preview.as_deref(), Some("hello"));
        assert_eq!(row.user_call_id.as_deref(), Some("c1"));
        assert_eq!(row.final_answer_preview.as_deref(), Some("world"));
        assert_eq!(row.final_call_id.as_deref(), Some("c2"));
        assert_eq!(row.tool_call_total, 4);
        assert_eq!(row.agent_topology.as_deref(), Some("sub_agent"));

        // JSON-encoded columns are real arrays / objects, not raw strings.
        let span_ids: Vec<String> = serde_json::from_str(&row.span_ids).unwrap();
        assert_eq!(span_ids, vec!["c1".to_string(), "c2".to_string()]);
        let models: Vec<String> = serde_json::from_str(row.models_used.as_deref().unwrap()).unwrap();
        assert_eq!(models, vec!["gpt-4".to_string()]);
        let subs: Vec<String> =
            serde_json::from_str(row.subagents_used.as_deref().unwrap()).unwrap();
        assert_eq!(subs, vec!["task".to_string()]);
        let md: serde_json::Value = serde_json::from_str(row.metadata.as_deref().unwrap()).unwrap();
        assert_eq!(md["k"], "v");
        let surfaces: Vec<String> =
            serde_json::from_str(row.tool_surfaces_json.as_deref().unwrap()).unwrap();
        assert_eq!(surfaces, vec!["mcp".to_string(), "cli".to_string()]);
        let susp: Vec<serde_json::Value> =
            serde_json::from_str(row.suspicious_skills_json.as_deref().unwrap()).unwrap();
        assert_eq!(susp[0]["tool_name"], "bash");
        assert_eq!(susp[0]["reason"], "shell");
    }

    #[test]
    fn turn_row_version_is_end_time_micros() {
        // Initial finalize version = end_time (micros); update_trace_metadata
        // re-inserts with a strictly-greater wall-clock-micros version.
        let end = 1_700_000_001_000_000_i64;
        let row = TurnRow::from(sample_turn(end));
        assert_eq!(row._version, end.max(0) as u64);
    }

    #[test]
    fn turn_row_version_clamps_negative_end_time() {
        let row = TurnRow::from(sample_turn(-5));
        assert_eq!(row._version, 0);
    }

    #[test]
    fn exchange_row_from_http_exchange_maps_addrs_and_bodies() {
        let x = sample_exchange("xchg-1", 1_700_000_000_000_000);
        let row = ExchangeRow::from(x);
        assert_eq!(row.id, "xchg-1");
        assert_eq!(row.source_id, "src-0");
        assert_eq!(row.client_ip, "10.0.0.1");
        assert_eq!(row.client_port, 54321);
        assert_eq!(row.server_ip, "10.0.0.2");
        assert_eq!(row.server_port, 443);
        assert_eq!(row.method, "POST");
        assert_eq!(row.uri, "/v1/chat/completions");
        assert_eq!(row.request_body.as_deref(), Some(r#"{"model":"gpt-4"}"#));
        assert_eq!(row.status, Some(200));
        assert_eq!(row.response_body.as_deref(), Some(r#"{"choices":[]}"#));
        assert!(!row.is_sse);
        assert_eq!(row.sse_event_count, 0);
        assert_eq!(row.sse_data_bytes, 0);
        assert_eq!(row.request_time, 1_700_000_000_000_000);
        assert_eq!(row.response_first_byte_time, Some(1_700_000_000_500_000));
        assert_eq!(row.response_complete_time, Some(1_700_000_001_000_000));
        // Headers serialized as JSON pair arrays.
        let req: serde_json::Value = serde_json::from_str(&row.request_headers).unwrap();
        assert_eq!(req[0][0], "content-type");
    }

    #[test]
    fn exchange_row_empty_request_body_becomes_none() {
        let mut x = sample_exchange("x", 0);
        // Replace the request with one whose body is empty.
        let mut req = (*x.request).clone();
        req.body = bytes::Bytes::new();
        x.request = std::sync::Arc::new(req);
        let row = ExchangeRow::from(x);
        assert_eq!(row.request_body, None);
    }

    /// Minimal paired HTTP exchange (generic IPs, placeholder ids) for the
    /// `ExchangeRow::from` mapping — kept local so the test module is
    /// self-contained. Mirrors the shape of the live-IT fixture.
    fn sample_exchange(id: &str, request_time_us: i64) -> HttpExchange {
        use bytes::Bytes;
        use h_protocol::model::{HttpRequestData, HttpResponseData};
        use h_protocol::net::FlowKey;
        use std::sync::Arc;
        let client_ip: IpAddr = "10.0.0.1".parse().unwrap();
        let server_ip: IpAddr = "10.0.0.2".parse().unwrap();
        let request = Arc::new(HttpRequestData {
            flow_key: FlowKey::new("src-0".into(), client_ip, 54321, server_ip, 443),
            client_addr: (client_ip, 54321),
            server_addr: (server_ip, 443),
            method: "POST".into(),
            uri: "/v1/chat/completions".into(),
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
            status: 200,
            version: 1,
            headers: vec![("x-request-id".into(), "req_abc".into())],
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
}
