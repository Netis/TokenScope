//! Live-server integration tests, gated on `SGLAKE_TEST_URL`.
//!
//! sglake has no in-process mode, so these need a real sglogd. When
//! `SGLAKE_TEST_URL` is unset every test self-skips, keeping
//! `cargo test --workspace` green without a server. To run them:
//!
//! ```bash
//! D=$(mktemp -d) && sglogd --data-dir "$D" --listen 127.0.0.1:5970 \
//!     --hec-token heron-it --no-self-trace --max-hot-raw-mib 2048 &
//! SGLAKE_TEST_URL=http://127.0.0.1:5970 SGLAKE_TEST_TOKEN=heron-it \
//!     cargo test -p h-storage-sglake
//! ```
//!
//! **Isolation is per index prefix, not per database.** sglake has no
//! `DROP DATABASE` and no DDL at all — an index exists because something wrote
//! to it. Each test therefore gets a unique `index_prefix` and simply never
//! looks at anyone else's indexes. Nothing is cleaned up; the test data-dir is
//! disposable.
//!
//! **Reads poll instead of sleeping.** A write is durable when HEC returns 200,
//! but "durable" and "searchable" are not the same instant. Polling to a
//! deadline both keeps the suite fast and makes the actual visibility lag
//! observable rather than papered over by a fixed sleep.

#![cfg(test)]

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use std::net::IpAddr;
use std::sync::Arc;

use h_common::config::SglakeConfig;
use h_metrics::model::LlmFinishMetric;
use h_protocol::model::{HttpRequestData, HttpResponseData};
use h_protocol::net::FlowKey;
use h_protocol::HttpExchange;
use h_storage::StorageBackend;

use crate::rows::fixtures;
use crate::SglakeBackend;

/// How long a write may take to become searchable before a test gives up.
const VISIBLE_WITHIN: Duration = Duration::from_secs(20);

static PREFIX_SEQ: AtomicU32 = AtomicU32::new(0);

/// Build a backend against a fresh, unused index prefix. Returns `None` (test
/// self-skips) when `SGLAKE_TEST_URL` is unset.
async fn fresh_backend() -> Option<SglakeBackend> {
    let url = std::env::var("SGLAKE_TEST_URL").ok()?;
    // Unique per process *and* per test, so a re-run against a persistent
    // data-dir never reads a previous run's events.
    let nonce = uuid::Uuid::now_v7().simple().to_string();
    let seq = PREFIX_SEQ.fetch_add(1, Ordering::Relaxed);
    let cfg = SglakeConfig {
        url,
        hec_token: std::env::var("SGLAKE_TEST_TOKEN").unwrap_or_default(),
        index_prefix: format!("it{seq}{}", &nonce[..12]),
        ..Default::default()
    };
    let backend = SglakeBackend::new(&cfg).expect("build backend");
    backend.init().await.expect("init");
    Some(backend)
}

macro_rules! require_backend {
    () => {
        match crate::it::fresh_backend().await {
            Some(b) => b,
            None => {
                eprintln!("skip: SGLAKE_TEST_URL unset");
                return;
            }
        }
    };
}

/// Poll `f` until it returns `Some`, or fail with how long we waited.
async fn eventually<T, F, Fut>(what: &str, mut f: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let start = Instant::now();
    loop {
        if let Some(v) = f().await {
            let waited = start.elapsed();
            if waited > Duration::from_secs(1) {
                eprintln!("note: {what} became searchable after {waited:?}");
            }
            return v;
        }
        assert!(
            start.elapsed() < VISIBLE_WITHIN,
            "{what} never became searchable within {VISIBLE_WITHIN:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn sample_exchange(id: &str, request_time_us: i64) -> HttpExchange {
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

/// The field-by-field acceptance check: one span written, one span read, every
/// value compared. This is the test that catches the encoding hazards —
/// microsecond truncation, `None` decaying into a zero value, a `Vec` losing
/// its order or collapsing to a scalar.
#[tokio::test]
async fn span_round_trips_every_field() {
    let backend = require_backend!();
    let call = fixtures::full_call();
    backend.write_spans(vec![call.clone()]).await.unwrap();

    let got = eventually("span", || async {
        backend.query_span_by_id(&call.id).await.unwrap()
    })
    .await;

    assert_eq!(got.id, call.id);
    assert_eq!(got.source_id, call.source_id);
    // Detail timestamps are milliseconds. The point of the integer `ts_us`
    // field is that this survives exactly, with no f64 rounding.
    assert_eq!(got.request_time, call.request_time / 1000);
    assert_eq!(got.response_time, Some(call.response_time.unwrap() / 1000));
    assert_eq!(got.complete_time, Some(call.complete_time.unwrap() / 1000));
    assert_eq!(got.wire_api, call.wire_api);
    assert_eq!(got.model, call.model);
    assert_eq!(got.api_type, call.api_type.to_string());
    assert_eq!(got.is_stream, call.is_stream);
    assert_eq!(got.request_path, call.request_path);
    assert_eq!(got.status_code, call.status_code);
    assert_eq!(got.finish_reason, call.finish_reason);
    assert_eq!(got.input_tokens, call.input_tokens);
    assert_eq!(got.output_tokens, call.output_tokens);
    assert_eq!(got.total_tokens, call.total_tokens);
    assert_eq!(got.ttft_ms, call.ttft_ms);
    assert_eq!(got.e2e_latency_ms, call.e2e_latency_ms);
    assert_eq!(got.response_id, call.response_id);
    assert_eq!(got.client_ip, call.client_ip.to_string());
    assert_eq!(got.client_port, call.client_port);
    assert_eq!(got.server_ip, call.server_ip.to_string());
    assert_eq!(got.server_port, call.server_port);
    assert_eq!(got.is_agent_request, call.is_agent_request);
    assert_eq!(got.tool_surface.as_deref(), Some("function_call"));
    assert_eq!(got.agent_topology.as_deref(), Some("single_agent"));
    assert_eq!(got.tool_call_count, call.tool_call_count);
    // Order matters and must not be reordered or collapsed.
    assert_eq!(got.tool_names, call.tool_names);
    assert_eq!(got.process.as_ref().unwrap().pid, 4242);
    assert_eq!(got.process.as_ref().unwrap().comm, "node");
    assert_eq!(
        got.process.as_ref().unwrap().exe.as_deref(),
        Some("/usr/bin/node")
    );
    // Bodies come from the second index.
    assert_eq!(got.request_body, call.request_body);
    assert_eq!(got.response_body, call.response_body);
    assert!(got.request_headers.unwrap().contains("api.example"));
    assert!(got.response_headers.unwrap().contains("uvicorn"));
}

/// The null-vs-absent case. Every `Option` is `None` on the way in, and every
/// one has to still be `None` on the way out — not `Some(0)`, not `Some("")`.
#[tokio::test]
async fn minimal_span_keeps_every_none() {
    let backend = require_backend!();
    let mut call = fixtures::minimal_call();
    call.id = uuid::Uuid::now_v7().to_string();
    backend.write_spans(vec![call.clone()]).await.unwrap();

    let got = eventually("minimal span", || async {
        backend.query_span_by_id(&call.id).await.unwrap()
    })
    .await;

    assert_eq!(got.response_time, None);
    assert_eq!(got.complete_time, None);
    assert_eq!(got.status_code, None);
    assert_eq!(got.finish_reason, None);
    assert_eq!(got.input_tokens, None);
    assert_eq!(got.output_tokens, None);
    assert_eq!(got.total_tokens, None);
    assert_eq!(got.ttft_ms, None);
    assert_eq!(got.e2e_latency_ms, None);
    assert_eq!(got.response_id, None);
    assert_eq!(got.tool_surface, None);
    assert_eq!(got.agent_topology, None);
    assert!(got.tool_names.is_empty());
    assert!(got.process.is_none());
    // No bodies and no headers were stored, so there is no body event at all.
    assert_eq!(got.request_body, None);
    assert_eq!(got.response_body, None);
}

#[tokio::test]
async fn unknown_ids_return_none_not_an_error() {
    let backend = require_backend!();
    assert!(backend
        .query_span_by_id(&uuid::Uuid::now_v7().to_string())
        .await
        .unwrap()
        .is_none());
    assert!(backend
        .query_trace_by_id("no-such-turn")
        .await
        .unwrap()
        .is_none());
    assert!(backend
        .query_http_exchange_by_id("no-such-exchange")
        .await
        .unwrap()
        .is_none());
    assert!(backend
        .query_trace_spans("no-such-turn", true)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn trace_round_trips_and_resolves_its_spans() {
    let backend = require_backend!();
    let mut trace = fixtures::full_trace();
    trace.turn_id = uuid::Uuid::now_v7().to_string();

    // Three calls, written out of order, with the middle two sharing a
    // microsecond so the tie-break is actually exercised.
    let base = trace.start_time_us;
    let mut calls = Vec::new();
    for (i, offset) in [2_000_000_i64, 1_000_000, 1_000_000]
        .into_iter()
        .enumerate()
    {
        let mut c = fixtures::full_call();
        c.id = format!("{}-span-{i}", trace.turn_id);
        c.request_time = base + offset;
        c.complete_time = Some(base + offset + 100_000);
        calls.push(c);
    }
    trace.span_ids = calls.iter().map(|c| c.id.clone()).collect();
    trace.end_time_us = base + 3_000_000;

    backend.write_spans(calls.clone()).await.unwrap();
    backend.write_traces(vec![trace.clone()]).await.unwrap();

    let detail = eventually("trace", || async {
        backend.query_trace_by_id(&trace.turn_id).await.unwrap()
    })
    .await;
    assert_eq!(detail.turn_id, trace.turn_id);
    assert_eq!(detail.session_id, trace.session_id);
    assert_eq!(detail.status, "complete");
    assert_eq!(detail.call_count, trace.call_count);
    assert_eq!(detail.start_time, trace.start_time_us / 1000);
    assert_eq!(detail.end_time, trace.end_time_us / 1000);
    assert_eq!(detail.models_used, trace.models_used);
    assert_eq!(detail.subagents_used, trace.subagents_used);
    assert_eq!(detail.span_ids, trace.span_ids);
    assert_eq!(detail.total_cost_usd, trace.total_cost_usd);
    assert_eq!(detail.total_input_tokens, trace.total_input_tokens);
    assert_eq!(detail.tool_surfaces, vec!["function_call".to_string()]);
    assert_eq!(detail.metadata.unwrap()["proxy"]["pair_id"], "group-9");

    let spans = eventually("trace spans", || async {
        let s = backend
            .query_trace_spans(&trace.turn_id, true)
            .await
            .unwrap();
        (s.len() == 3).then_some(s)
    })
    .await;

    // Ascending by request time, then completion, then id — deterministic even
    // for the two spans sharing a microsecond.
    assert_eq!(spans[0].id, format!("{}-span-1", trace.turn_id));
    assert_eq!(spans[1].id, format!("{}-span-2", trace.turn_id));
    assert_eq!(spans[2].id, format!("{}-span-0", trace.turn_id));
    assert_eq!(
        spans.iter().map(|s| s.sequence).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert!(spans[0].request_time <= spans[2].request_time);
    assert!(spans[0].request_body.is_some());

    // Lite mode drops exactly the four heavy fields and nothing else.
    let lite = backend
        .query_trace_spans(&trace.turn_id, false)
        .await
        .unwrap();
    assert_eq!(lite.len(), 3);
    for (full, lite) in spans.iter().zip(lite.iter()) {
        assert_eq!(full.id, lite.id);
        assert_eq!(full.sequence, lite.sequence);
        assert_eq!(full.request_time, lite.request_time);
        assert_eq!(full.input_tokens, lite.input_tokens);
        // Precomputed at write time, so unlike the SQL backends this stays
        // correct without the body.
        assert_eq!(full.tokens_estimated, lite.tokens_estimated);
        assert!(lite.request_body.is_none());
        assert!(lite.response_body.is_none());
        assert!(lite.request_headers.is_none());
        assert!(lite.response_headers.is_none());
    }

    // Same rows, reached by the in-memory-registry path instead of the trace.
    let by_ids = backend
        .query_spans_by_ids(&trace.span_ids, false)
        .await
        .unwrap();
    assert_eq!(
        by_ids.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        spans.iter().map(|s| s.id.clone()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn http_exchange_round_trips_with_microsecond_times() {
    let backend = require_backend!();
    let id = uuid::Uuid::now_v7().to_string();
    let ts = 1_785_638_114_914_200_i64;
    let x = sample_exchange(&id, ts);
    backend.write_exchanges(vec![x]).await.unwrap();

    let got = eventually("exchange", || async {
        backend.query_http_exchange_by_id(&id).await.unwrap()
    })
    .await;

    assert_eq!(got.id, id);
    assert_eq!(got.method, "POST");
    assert_eq!(got.uri, "/v1/chat/completions");
    assert_eq!(got.status, Some(200));
    assert_eq!(got.client_ip, "10.0.0.1");
    assert_eq!(got.client_port, 54321);
    assert_eq!(got.server_ip, "10.0.0.2");
    assert_eq!(got.server_port, 443);
    assert!(!got.is_sse);
    assert_eq!(got.sse_event_count, 0);
    // The one read that keeps microseconds rather than milliseconds.
    assert_eq!(got.request_time, ts);
    assert_eq!(got.response_first_byte_time, Some(ts + 500_000));
    assert_eq!(got.response_complete_time, Some(ts + 1_000_000));
    assert!(got.request_headers.contains("application/json"));
    assert!(got.response_headers.contains("req_abc"));
    assert_eq!(got.request_body.as_deref(), Some(r#"{"model":"gpt-4"}"#));
    assert_eq!(got.response_body.as_deref(), Some(r#"{"choices":[]}"#));
}

/// Metrics have no by-id read yet, so this asserts what Phase 1 can: the
/// writes are accepted and land in the granularity-specific index.
#[tokio::test]
async fn metrics_write_to_their_granularity_index() {
    let backend = require_backend!();
    let mut m = fixtures::sample_metric();
    m.granularity = "10s";
    let f = LlmFinishMetric {
        timestamp_us: m.timestamp_us,
        source_id: m.source_id.clone(),
        granularity: "10s".into(),
        wire_api: m.wire_api.clone(),
        model: m.model.clone(),
        server_ip: m.server_ip.clone(),
        finish_reason: "end_turn".into(),
        count: 4,
    };
    backend.write_metrics(vec![m]).await.unwrap();
    backend.write_finish_metrics(vec![f]).await.unwrap();

    let metrics_ix = backend.ix.metrics_for("10s").unwrap().to_string();
    let finish_ix = backend.ix.finish_for("10s").unwrap().to_string();
    for ix in [metrics_ix, finish_ix] {
        let backend = &backend;
        let ix = &ix;
        eventually(&format!("rows in {ix}"), || async move {
            let n = backend
                .search
                .search_all_time(&format!("search index={ix} | stats count as n | table n"))
                .await
                .unwrap()
                .rows()
                .first()
                .and_then(|r| r.get("n"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            (n == 1).then_some(n)
        })
        .await;
    }
}

/// Empty writes must not produce an empty HTTP request — the sink calls these
/// on every flush tick whether or not anything accumulated.
#[tokio::test]
async fn empty_writes_are_no_ops() {
    let backend = require_backend!();
    backend.write_spans(vec![]).await.unwrap();
    backend.write_traces(vec![]).await.unwrap();
    backend.write_metrics(vec![]).await.unwrap();
    backend.write_finish_metrics(vec![]).await.unwrap();
    backend.write_exchanges(vec![]).await.unwrap();
    assert!(backend
        .query_spans_by_ids(&[], true)
        .await
        .unwrap()
        .is_empty());
}
