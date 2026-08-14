//! sglake (sglog) implementation of [`StorageBackend`].
//!
//! A third backend alongside `h-storage-duckdb` and `h-storage-clickhouse`,
//! targeting a Splunk-compatible log platform rather than a SQL database.
//! Writes go over the HTTP Event Collector; reads are SPL over
//! `/api/v1/search`. Both are plain HTTP, so — like the ClickHouse backend —
//! there is no `spawn_blocking`, no writer mutex, and no reader pool.
//!
//! Module layout mirrors `h-storage-clickhouse` so the backends diff side by
//! side, plus two modules with no SQL counterpart:
//!   * `schema`  — index naming + `init()` (indexes are created on first write)
//!   * `client`  — `HecClient` (writes) + `SearchClient` (reads)
//!   * `rows`    — domain structs → HEC events, and search rows → query types
//!   * `spl`     — quoting, IN-lists, time windows, the pagination template
//!   * `dims`    — the SPL equivalent of `h_storage::dialect`'s wildcard tiers
//!   * `calls` / `turns` / `sessions` / `metrics` / `services` / `exchanges` /
//!     `distincts` / `retention` — one module per entity, same split as the
//!     other two backends.
//!
//! # Durability contract: at-least-once
//!
//! [`h_storage::WriteBuffer`] drops a batch when `flush` returns `Err` and
//! cannot retry (`Vec<T>` is not `Clone`), so every retry lives inside
//! [`client::HecClient`]. HEC returns 200 only after the events are fsynced,
//! and a partial-success 400 reports the index of the first bad event, so the
//! retry loop can advance deterministically instead of resending blindly.
//! What it cannot do is deduplicate across a sglogd restart — ack ids are
//! process-local. Duplicates therefore remain possible and surface as repeated
//! rows; `metrics_dedup` exists for the one case where that would corrupt a
//! value rather than just look odd.
//!
//! # Known divergences from the SQL backends
//!
//! * `update_trace_metadata` is a no-op unless `enable_trace_patching` is set:
//!   emulating updates on an append-only store costs a full-window sort on
//!   every traces read, which defeats the pagination design. While it is off,
//!   proxy pairing does not annotate traces (`proxy_role` / `proxy_peer_turn_id`
//!   stay `None`, and topology loses its `proxy` edges).
//! * `query_services_topology` bounds the number of turns it will consider;
//!   past that it returns a truncated graph rather than timing out.
//! * Bodies live in their own indexes, so `include_bodies = false` genuinely
//!   avoids fetching them rather than merely projecting them away.

mod calls;
mod client;
mod dims;
mod distincts;
mod exchanges;
mod it;
mod metrics;
mod read;
mod rows;
mod schema;
mod services;
mod sessions;
mod spl;
mod turns;

use async_trait::async_trait;

use h_common::config::SglakeConfig;
use h_common::error::Result;
use h_llm::model::LlmCall;
use h_metrics::model::{LlmFinishMetric, LlmMetric};
use h_protocol::HttpExchange;
use h_turn::{PairCandidate, Trace};

use h_storage::query::*;
use h_storage::retention::{RetentionPolicy, RetentionReport};
use h_storage::StorageBackend;

pub use schema::Indexes;

/// sglake storage backend. Holds the two HTTP clients plus the resolved index
/// names and behaviour knobs.
pub struct SglakeBackend {
    pub(crate) hec: client::HecClient,
    pub(crate) search: client::SearchClient,
    pub(crate) ix: Indexes,
    pub(crate) store_bodies: bool,
    #[allow(dead_code)] // wired up in Phase 2 (offset-pagination guard)
    pub(crate) max_page_offset: u64,
    #[allow(dead_code)] // wired up in Phase 2 (session list scan guard)
    pub(crate) max_sessions_scan: u64,
    #[allow(dead_code)] // wired up in Phase 2 (trace end-time window widening)
    pub(crate) trace_time_skew_us: i64,
    #[allow(dead_code)] // wired up in Phase 3 (metrics read dedup)
    pub(crate) metrics_dedup: bool,
    #[allow(dead_code)] // wired up in Phase 4 (append-a-revision trace patching)
    pub(crate) enable_trace_patching: bool,
    #[allow(dead_code)] // wired up in Phase 4 (per-index retention push)
    pub(crate) manage_retention: bool,
}

impl SglakeBackend {
    /// Build a backend from config. Construction performs no network I/O —
    /// indexes are materialized lazily on first write, and `init()` only
    /// probes and reports.
    pub fn new(config: &SglakeConfig) -> Result<Self> {
        // Refuse a prefix that would land Heron's data in one of sglake's own
        // indexes. `traces` is the dangerous one: it already holds OTLP spans,
        // including the ones sglogd writes about its own searches, and mixing
        // in Heron events would corrupt a dataset this backend does not own.
        let ix = Indexes::new(&config.index_prefix);
        if let Some(clash) = ix
            .all()
            .into_iter()
            .find(|n| schema::RESERVED_INDEXES.contains(n))
        {
            return Err(h_common::error::AppError::Config(format!(
                "storage.sglake.index_prefix = {:?} produces the reserved sglake \
                 index {:?}; choose another prefix",
                config.index_prefix, clash
            )));
        }
        Ok(Self {
            hec: client::HecClient::new(config)?,
            search: client::SearchClient::new(config)?,
            ix,
            store_bodies: config.store_bodies,
            max_page_offset: config.max_page_offset,
            max_sessions_scan: config.max_sessions_scan,
            trace_time_skew_us: config.trace_time_skew_hours as i64 * 3_600_000_000,
            metrics_dedup: config.metrics_dedup,
            enable_trace_patching: config.enable_trace_patching,
            manage_retention: config.manage_retention,
        })
    }
}

#[async_trait]
impl StorageBackend for SglakeBackend {
    async fn init(&self) -> Result<()> {
        schema::init(self).await
    }

    async fn write_spans(&self, calls: Vec<LlmCall>) -> Result<()> {
        SglakeBackend::write_spans(self, calls).await
    }

    async fn write_metrics(&self, metrics: Vec<LlmMetric>) -> Result<()> {
        SglakeBackend::write_metrics(self, metrics).await
    }

    async fn write_finish_metrics(&self, metrics: Vec<LlmFinishMetric>) -> Result<()> {
        SglakeBackend::write_finish_metrics(self, metrics).await
    }

    async fn write_traces(&self, turns: Vec<Trace>) -> Result<()> {
        SglakeBackend::write_traces(self, turns).await
    }

    async fn write_exchanges(&self, exchanges: Vec<HttpExchange>) -> Result<()> {
        SglakeBackend::write_exchanges(self, exchanges).await
    }

    // ---- Phase 2: lists + pagination -------------------------------------

    async fn query_spans(&self, query: &SpansQuery) -> Result<SpansPage> {
        SglakeBackend::query_spans(self, query).await
    }

    async fn query_traces(&self, query: &TracesQuery) -> Result<TracesPage> {
        SglakeBackend::query_traces(self, query).await
    }

    async fn query_http_exchanges(&self, query: &HttpExchangesQuery) -> Result<HttpExchangesPage> {
        SglakeBackend::query_http_exchanges(self, query).await
    }

    async fn query_sessions(&self, query: &SessionListQuery) -> Result<SessionsPage> {
        SglakeBackend::query_sessions(self, query).await
    }

    async fn query_session_by_id(
        &self,
        source_id: &str,
        session_id: &str,
    ) -> Result<Option<SessionDetail>> {
        SglakeBackend::query_session_by_id(self, source_id, session_id).await
    }

    async fn query_session_traces(&self, query: &SessionTracesQuery) -> Result<SessionTracesPage> {
        SglakeBackend::query_session_traces(self, query).await
    }

    // ---- Phase 1: point lookups ------------------------------------------

    async fn query_span_by_id(&self, id: &str) -> Result<Option<SpanDetail>> {
        SglakeBackend::query_span_by_id(self, id).await
    }

    async fn query_trace_by_id(&self, turn_id: &str) -> Result<Option<TraceDetail>> {
        SglakeBackend::query_trace_by_id(self, turn_id).await
    }

    async fn query_trace_spans(
        &self,
        turn_id: &str,
        include_bodies: bool,
    ) -> Result<Vec<TraceSpanItem>> {
        SglakeBackend::query_trace_spans(self, turn_id, include_bodies).await
    }

    async fn query_spans_by_ids(
        &self,
        span_ids: &[String],
        include_bodies: bool,
    ) -> Result<Vec<TraceSpanItem>> {
        // No turn to borrow a time window from — these ids come from the
        // in-memory registry for turns that have not been persisted yet, so
        // the ids themselves are the only bound available.
        SglakeBackend::read_spans_by_ids(self, span_ids, include_bodies, None).await
    }

    async fn query_http_exchange_by_id(&self, id: &str) -> Result<Option<HttpExchangeDetail>> {
        SglakeBackend::query_http_exchange_by_id(self, id).await
    }

    // ---- Phase 3: aggregates ---------------------------------------------

    async fn query_metrics_timeseries(
        &self,
        query: &MetricsTimeseriesQuery,
    ) -> Result<Vec<MetricsTimeseriesRow>> {
        SglakeBackend::query_metrics_timeseries(self, query).await
    }

    async fn query_metrics_summary(
        &self,
        query: &MetricsSummaryQuery,
    ) -> Result<MetricsSummaryRow> {
        SglakeBackend::query_metrics_summary(self, query).await
    }

    async fn query_metrics_models(
        &self,
        query: &MetricsModelsQuery,
    ) -> Result<Vec<MetricsModelRow>> {
        SglakeBackend::query_metrics_models(self, query).await
    }

    async fn query_finish_reasons(
        &self,
        query: &FinishReasonsQuery,
    ) -> Result<Vec<FinishReasonTimeseries>> {
        SglakeBackend::query_finish_reasons(self, query).await
    }

    async fn query_services(&self, query: &ServicesQuery) -> Result<Vec<ServiceRow>> {
        SglakeBackend::query_services(self, query).await
    }

    async fn query_services_topology(
        &self,
        query: &ServicesTopologyQuery,
    ) -> Result<ServicesTopology> {
        SglakeBackend::query_services_topology(self, query).await
    }

    async fn query_agent_summary(
        &self,
        query: &AgentSummaryQuery,
    ) -> Result<Vec<AgentKindSummary>> {
        SglakeBackend::query_agent_summary(self, query).await
    }

    async fn query_agent_activity(
        &self,
        query: &AgentActivityQuery,
    ) -> Result<Vec<AgentActivityPoint>> {
        SglakeBackend::query_agent_activity(self, query).await
    }

    async fn query_distinct_wire_apis(&self) -> Result<Vec<String>> {
        SglakeBackend::query_distinct_wire_apis(self).await
    }

    async fn query_distinct_models(&self) -> Result<Vec<String>> {
        SglakeBackend::query_distinct_models(self).await
    }

    async fn query_distinct_server_ips(&self) -> Result<Vec<String>> {
        SglakeBackend::query_distinct_server_ips(self).await
    }

    async fn query_distinct_agent_kinds(
        &self,
        query: &DistinctAgentKindsQuery,
    ) -> Result<Vec<String>> {
        SglakeBackend::query_distinct_agent_kinds(self, query).await
    }

    async fn query_distinct_finish_reasons(&self) -> Result<Vec<DistinctFinishReason>> {
        SglakeBackend::query_distinct_finish_reasons(self).await
    }

    // ---- Phase 4 ---------------------------------------------------------

    async fn apply_retention(&self, _policy: RetentionPolicy) -> Result<RetentionReport> {
        // Retention in sglake is per-index and bucket-granular, pushed through
        // its management API rather than executed as DELETEs. Wired up in
        // Phase 4; until then this is an explicit no-op.
        Ok(RetentionReport::default())
    }

    async fn query_pair_candidates(
        &self,
        _start_us: i64,
        _end_us: i64,
    ) -> Result<Vec<PairCandidate>> {
        // Paired with `update_trace_metadata` below: without a way to record
        // the pairing result there is no point discovering candidates.
        Ok(Vec::new())
    }

    // `update_trace_metadata` deliberately uses the trait's default no-op —
    // see the crate docs. `checkpoint_traces_writer` / `reopen_all_connections`
    // likewise: an HTTP client has no in-process MVCC or index state to
    // compact or reopen.
}
