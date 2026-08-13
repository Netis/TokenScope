//! Domain structs → HEC events.
//!
//! # Encoding rules
//!
//! * **Timestamps are written twice.** The HEC envelope's `time` drives bucket
//!   routing and pruning, but it round-trips through `f64` seconds and comes
//!   back out of search as `f64` too, which loses microseconds — measured at
//!   3.3% of rows off by 1 µs when truncating. So every event also carries the
//!   integer `ts_us`, and that is the authoritative value for ordering,
//!   cursors, and anything read back into a struct.
//! * **`None` omits the key.** Search output drops null fields entirely, so
//!   there is no way to distinguish an explicit null from an absent key;
//!   omitting is the smaller, equivalent encoding.
//! * **Bools are written twice**, as `true`/`false` and as a 0/1 twin
//!   (`strm`, `err`, `sse`). The integer form makes `sum(strm)` work and gives
//!   an exact posting to match on.
//! * **Range predicates are precomputed.** sglake cannot push down `<`, `>`,
//!   `!=` or `NOT`, so anything a query would need to compare is turned into a
//!   categorical value at write time (`err_class`, `strm`).
//! * **Arrays go in as JSON strings** (`*_json`), matching how the ClickHouse
//!   backend stores them, so `h_storage::convert::parse_json_string_list`
//!   decodes both without new code.
//! * **Field order is structural.** These are `#[derive(Serialize)]` structs,
//!   not maps: `serde_json`'s map orders keys alphabetically, which would move
//!   `span_id` to the end of a body event and break the anchored regex that
//!   extracts it without parsing the body.

use serde::Serialize;

use h_llm::model::LlmCall;

use crate::spl::epoch_secs;

/// HEC envelope. `host` doubles as the source id so `host=` filtering and the
/// native UI's grouping both work without extra configuration.
#[derive(Serialize)]
pub(crate) struct Envelope<T: Serialize> {
    pub time: String,
    pub host: String,
    pub source: &'static str,
    pub sourcetype: &'static str,
    pub index: String,
    pub event: T,
}

impl<T: Serialize> Envelope<T> {
    pub(crate) fn new(ts_us: i64, host: &str, sourcetype: &'static str, index: &str, event: T) -> Self {
        Self {
            time: epoch_secs(ts_us),
            host: host.to_string(),
            source: "heron",
            sourcetype,
            index: index.to_string(),
            event,
        }
    }

    pub(crate) fn encode(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

pub(crate) const ST_SPAN: &str = "heron_span";
pub(crate) const ST_BODY: &str = "heron_body";

/// Span metadata. Everything here is a scalar that queries filter, sort, or
/// aggregate on — bodies and headers live in [`BodyEvent`].
#[derive(Serialize)]
pub(crate) struct SpanEvent {
    pub id: String,
    pub source_id: String,
    pub kind: &'static str,
    /// Authoritative request timestamp, microseconds.
    pub ts_us: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resp_us: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_us: Option<i64>,
    pub wire_api: &'static str,
    pub model: String,
    pub api_type: String,
    pub is_stream: bool,
    /// 0/1 twin of `is_stream`, so `sum(strm)` counts streams directly.
    pub strm: u8,
    pub request_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    /// 1 when `status_code >= 400`. Precomputed because `>=` cannot be pushed
    /// down.
    pub err: u8,
    /// `ok` / `4xx` / `429` / `5xx` — the error buckets metrics needs, as
    /// exact-match values rather than range predicates.
    pub err_class: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub e2e_latency_ms: Option<f64>,
    pub client_ip: String,
    pub client_port: u16,
    pub server_ip: String,
    pub server_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    pub is_agent_request: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_surface: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_topology: Option<String>,
    pub tool_call_count: u32,
    pub tool_names_json: String,
    pub body_bytes_dropped: u64,
    /// Whether a companion body event was written; lets a reader skip the
    /// second lookup instead of discovering emptiness.
    pub has_body: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_comm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_exe: Option<String>,
}

/// Bodies and headers, one event per span.
///
/// `span_id` **must stay first**: this sourcetype is configured with
/// `auto_json = false` so sglake never parses the (up to ~320 KiB) payload,
/// and the id is instead pulled out by a regex anchored at the start of the
/// raw event.
#[derive(Serialize)]
pub(crate) struct BodyEvent {
    pub span_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_headers: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_headers: Option<String>,
}

fn err_class_of(status: Option<u16>) -> &'static str {
    match status {
        Some(429) => "429",
        Some(s) if s >= 500 => "5xx",
        Some(s) if s >= 400 => "4xx",
        _ => "ok",
    }
}

/// Split one call into its metadata event and (optionally) its body event.
pub(crate) fn span_events(call: &LlmCall, store_bodies: bool) -> (SpanEvent, Option<BodyEvent>) {
    let status = call.status_code;
    let has_body = store_bodies
        && (call.request_body.is_some()
            || call.response_body.is_some()
            || !call.request_headers.is_empty()
            || !call.response_headers.is_empty());

    let meta = SpanEvent {
        id: call.id.clone(),
        source_id: call.source_id.clone(),
        kind: "llm",
        ts_us: call.request_time,
        resp_us: call.response_time,
        done_us: call.complete_time,
        wire_api: call.wire_api,
        model: call.model.clone(),
        api_type: call.api_type.to_string(),
        is_stream: call.is_stream,
        strm: u8::from(call.is_stream),
        request_path: call.request_path.clone(),
        status_code: status,
        err: u8::from(status.is_some_and(|s| s >= 400)),
        err_class: err_class_of(status),
        finish_reason: call.finish_reason.clone(),
        input_tokens: call.input_tokens,
        output_tokens: call.output_tokens,
        total_tokens: call.total_tokens,
        cache_read_input_tokens: call.cache_read_input_tokens,
        cache_creation_input_tokens: call.cache_creation_input_tokens,
        ttft_ms: call.ttft_ms,
        e2e_latency_ms: call.e2e_latency_ms,
        client_ip: call.client_ip.to_string(),
        client_port: call.client_port,
        server_ip: call.server_ip.to_string(),
        server_port: call.server_port,
        response_id: call.response_id.clone(),
        is_agent_request: call.is_agent_request,
        tool_surface: call.tool_surface.map(|t| t.to_string()),
        agent_topology: call.agent_topology.map(|t| t.to_string()),
        tool_call_count: call.tool_call_count,
        tool_names_json: serde_json::to_string(&call.tool_names).unwrap_or_else(|_| "[]".into()),
        body_bytes_dropped: call.body_bytes_dropped,
        has_body,
        process_pid: call.process.as_ref().map(|p| p.pid),
        process_comm: call.process.as_ref().map(|p| p.comm.clone()),
        process_exe: call.process.as_ref().and_then(|p| p.exe.clone()),
    };

    let body = has_body.then(|| BodyEvent {
        span_id: call.id.clone(),
        request_body: call.request_body.clone(),
        response_body: call.response_body.clone(),
        request_headers: (!call.request_headers.is_empty())
            .then(|| h_storage::convert::headers_to_json(&call.request_headers)),
        response_headers: (!call.response_headers.is_empty())
            .then(|| h_storage::convert::headers_to_json(&call.response_headers)),
    });

    (meta, body)
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use h_common::agent::{AgentTopology, ToolSurface};
    use h_common::process::ProcessInfo;
    use h_llm::model::ApiType;
    use std::net::{IpAddr, Ipv4Addr};

    /// A fully-populated call. Every `Option` is `Some` and every collection is
    /// non-empty, so encoding covers the widest event shape.
    pub(crate) fn full_call() -> LlmCall {
        LlmCall {
            source_id: "src-0".into(),
            id: "019fc053-5fa2-7770-98aa-dd2014c18a51".into(),
            wire_api: "openai-chat",
            model: "gpt-4".into(),
            api_type: ApiType::Chat,
            request_time: 1_785_638_114_914_200,
            response_time: Some(1_785_638_115_014_200),
            complete_time: Some(1_785_638_115_914_200),
            request_path: "/v1/chat/completions".into(),
            is_stream: true,
            request_body: Some(r#"{"model":"gpt-4"}"#.into()),
            status_code: Some(200),
            finish_reason: Some("stop".into()),
            response_body: Some(r#"{"id":"chatcmpl-x"}"#.into()),
            input_tokens: Some(1234),
            output_tokens: Some(56),
            total_tokens: Some(1290),
            cache_read_input_tokens: Some(7),
            cache_creation_input_tokens: Some(8),
            ttft_ms: Some(123.4),
            e2e_latency_ms: Some(890.1),
            client_ip: IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9)),
            client_port: 51234,
            server_ip: IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            server_port: 8000,
            response_id: Some("chatcmpl-x".into()),
            request_headers: vec![("host".into(), "api.example".into())],
            response_headers: vec![("server".into(), "uvicorn".into())],
            is_agent_request: true,
            tool_surface: Some(ToolSurface::FunctionCall),
            agent_topology: Some(AgentTopology::SingleAgent),
            tool_call_count: 2,
            tool_names: vec!["Bash".into(), "Read".into()],
            body_bytes_dropped: 0,
            process: Some(ProcessInfo {
                pid: 4242,
                comm: "node".into(),
                exe: Some("/usr/bin/node".into()),
            }),
        }
    }

    /// The opposite extreme: every `Option` is `None`, every collection empty.
    /// This is the shape that exposes null-vs-absent bugs.
    pub(crate) fn minimal_call() -> LlmCall {
        LlmCall {
            response_time: None,
            complete_time: None,
            request_body: None,
            status_code: None,
            finish_reason: None,
            response_body: None,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
            ttft_ms: None,
            e2e_latency_ms: None,
            response_id: None,
            request_headers: vec![],
            response_headers: vec![],
            tool_surface: None,
            agent_topology: None,
            tool_names: vec![],
            process: None,
            ..full_call()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Emit real encoder output for the live round-trip check against sglake.
    /// Writes only when `SGLAKE_EMIT` names a path, so a normal `cargo test`
    /// run touches nothing.
    #[test]
    fn emit_sample_events() {
        let Ok(path) = std::env::var("SGLAKE_EMIT") else {
            return;
        };
        let mut out = String::new();
        for call in [fixtures::full_call(), fixtures::minimal_call()] {
            let (meta, body) = span_events(&call, true);
            out.push_str(
                &Envelope::new(call.request_time, &call.source_id, ST_SPAN, "heron_spans", meta)
                    .encode()
                    .unwrap(),
            );
            out.push('\n');
            if let Some(body) = body {
                out.push_str(
                    &Envelope::new(call.request_time, &call.source_id, ST_BODY, "heron_bodies", body)
                        .encode()
                        .unwrap(),
                );
                out.push('\n');
            }
        }
        std::fs::write(&path, out).expect("write sample");
    }

    /// The minimal call must not emit a single `null`, and must still carry
    /// every non-optional field.
    #[test]
    fn minimal_call_omits_all_optionals() {
        let (meta, body) = span_events(&fixtures::minimal_call(), true);
        let s = serde_json::to_string(&meta).unwrap();
        assert!(!s.contains("null"), "{s}");
        assert!(!s.contains("status_code"), "{s}");
        assert!(!s.contains("ttft_ms"), "{s}");
        // Non-optional fields survive, including the precomputed ones.
        assert!(s.contains(r#""err_class":"ok""#), "{s}");
        assert!(s.contains(r#""tool_names_json":"[]""#), "{s}");
        assert!(s.contains(r#""has_body":false"#), "{s}");
        // No bodies and no headers ⇒ no body event at all.
        assert!(body.is_none());
    }

    #[test]
    fn full_call_round_trips_every_field() {
        let call = fixtures::full_call();
        let (meta, body) = span_events(&call, true);
        let s = serde_json::to_string(&meta).unwrap();
        // ts_us is the authoritative timestamp and must stay an integer.
        assert!(s.contains(r#""ts_us":1785638114914200"#), "{s}");
        assert!(s.contains(r#""strm":1"#), "{s}");
        assert!(s.contains(r#""err":0"#), "{s}");
        assert!(s.contains(r#""tool_surface":"function_call""#), "{s}");
        assert!(s.contains(r#""agent_topology":"single_agent""#), "{s}");
        assert!(s.contains(r#""tool_names_json":"[\"Bash\",\"Read\"]""#), "{s}");
        assert!(s.contains(r#""process_pid":4242"#), "{s}");
        assert!(s.contains(r#""has_body":true"#), "{s}");

        let b = serde_json::to_string(&body.unwrap()).unwrap();
        assert!(b.starts_with(r#"{"span_id":"019fc053"#), "{b}");
        assert!(b.contains("request_headers"), "{b}");
    }

    /// `store_bodies = false` must suppress the body event entirely, and say so
    /// on the metadata event so readers skip the second lookup.
    #[test]
    fn store_bodies_false_suppresses_body_event() {
        let (meta, body) = span_events(&fixtures::full_call(), false);
        assert!(body.is_none());
        assert!(!meta.has_body);
    }

    #[test]
    fn err_class_covers_every_status_band() {
        assert_eq!(err_class_of(None), "ok");
        assert_eq!(err_class_of(Some(200)), "ok");
        assert_eq!(err_class_of(Some(399)), "ok");
        assert_eq!(err_class_of(Some(400)), "4xx");
        assert_eq!(err_class_of(Some(404)), "4xx");
        // 429 is its own bucket and must win over the 4xx arm.
        assert_eq!(err_class_of(Some(429)), "429");
        assert_eq!(err_class_of(Some(499)), "4xx");
        assert_eq!(err_class_of(Some(500)), "5xx");
        assert_eq!(err_class_of(Some(503)), "5xx");
    }

    /// The anchored regex in props.toml only finds `span_id` if it is the very
    /// first key. Alphabetical map ordering would put it last.
    #[test]
    fn body_event_serializes_span_id_first() {
        let b = BodyEvent {
            span_id: "abc-123".into(),
            request_body: Some("{}".into()),
            response_body: None,
            request_headers: None,
            response_headers: None,
        };
        let s = serde_json::to_string(&b).unwrap();
        assert!(s.starts_with(r#"{"span_id":"abc-123""#), "{s}");
    }

    #[test]
    fn none_fields_are_omitted_not_nulled() {
        let b = BodyEvent {
            span_id: "x".into(),
            request_body: None,
            response_body: None,
            request_headers: None,
            response_headers: None,
        };
        let s = serde_json::to_string(&b).unwrap();
        assert_eq!(s, r#"{"span_id":"x"}"#);
        assert!(!s.contains("null"));
    }

    #[test]
    fn envelope_time_keeps_microsecond_precision() {
        let e = Envelope::new(1_785_638_114_914_200, "src-0", ST_SPAN, "heron_spans", ());
        let s = e.encode().unwrap();
        assert!(s.contains(r#""time":"1785638114.914200""#), "{s}");
        assert!(s.contains(r#""sourcetype":"heron_span""#), "{s}");
        assert!(s.contains(r#""host":"src-0""#), "{s}");
    }
}
