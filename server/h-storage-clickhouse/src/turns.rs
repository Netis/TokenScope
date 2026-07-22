//! `traces` table I/O — write, paginated query, by-id detail, pair-sweeper
//! support (`query_pair_candidates` / `update_trace_metadata`).
//!
//! `traces` is `ReplacingMergeTree(_version)`: it is the only mutated
//! table. Writes insert with `_version = end_time` (micros); reads use `FINAL`;
//! `update_trace_metadata` reads the full row (FINAL), merges the JSON patch, and
//! re-inserts the whole row with a wall-clock-micros `_version` so the latest
//! metadata wins on the next FINAL read.

use std::time::{SystemTime, UNIX_EPOCH};

use clickhouse::Row;
use serde::Deserialize;

use h_common::error::{AppError, Result};
use h_storage::convert::parse_json_string_list;
use h_storage::query::*;
use h_turn::{Trace, PairCandidate};

use crate::client::{ch_err, insert_all};
use crate::rows::TurnRow;
use crate::sql::{escape_str, sql_in_list, time_where};
use crate::ClickHouseBackend;

/// Full `traces` column list in `TurnRow` field order, with the two
/// `DateTime64(6)` columns surfaced as `i64` micros so they deserialize into
/// `TurnRow`'s `i64` fields and round-trip on re-insert. Used by
/// `update_trace_metadata`'s read-modify-write.
const TURN_ROW_SELECT: &str = "turn_id, source_id, session_id, wire_api, agent_kind, \
     client_ip, server_ip, \
     toUnixTimestamp64Micro(start_time) AS start_time, \
     toUnixTimestamp64Micro(end_time) AS end_time, \
     duration_ms, call_count, models_used, subagents_used, \
     total_input_tokens, total_output_tokens, \
     total_cache_read_input_tokens, total_cache_creation_input_tokens, \
     total_cost_usd, status, final_finish_reason, \
     user_input_preview, user_call_id, final_answer_preview, final_call_id, \
     span_ids, metadata, tool_surfaces_json, tool_call_total, agent_topology, \
     suspicious_skills_json, _version";

/// Read `metadata.proxy.{role, peer_turn_id, peer_turn_ids}` out of a row's
/// stored JSON. All-`None` for direct turns. Ported verbatim from the DuckDB
/// backend so list + detail share one parsing rule.
fn extract_proxy_fields(
    metadata_raw: Option<String>,
) -> (Option<String>, Option<String>, Option<Vec<String>>) {
    let Some(text) = metadata_raw else {
        return (None, None, None);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (None, None, None);
    };
    let proxy = v.get("proxy");
    let role = proxy
        .and_then(|p| p.get("role"))
        .and_then(|r| r.as_str())
        .map(String::from);
    let peer_id = proxy
        .and_then(|p| p.get("peer_turn_id"))
        .and_then(|r| r.as_str())
        .map(String::from);
    let peer_ids = proxy.and_then(|p| p.get("peer_turn_ids")).and_then(|a| {
        a.as_array().map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
    });
    (role, peer_id, peer_ids)
}

fn now_micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_proxy_fields_missing_metadata() {
        let (role, peer, peer_ids) = extract_proxy_fields(None);
        assert_eq!(role, None);
        assert_eq!(peer, None);
        assert_eq!(peer_ids, None);
    }

    #[test]
    fn extract_proxy_fields_non_json_metadata() {
        let (role, peer, peer_ids) = extract_proxy_fields(Some("not-json".into()));
        assert_eq!(role, None);
        assert_eq!(peer, None);
        assert_eq!(peer_ids, None);
    }

    #[test]
    fn extract_proxy_fields_json_without_proxy() {
        let (role, peer, peer_ids) =
            extract_proxy_fields(Some(r#"{"other":"value"}"#.into()));
        assert_eq!(role, None);
        assert_eq!(peer, None);
        assert_eq!(peer_ids, None);
    }

    #[test]
    fn extract_proxy_fields_role_only() {
        let (role, peer, peer_ids) =
            extract_proxy_fields(Some(r#"{"proxy":{"role":"proxy_in"}}"#.into()));
        assert_eq!(role.as_deref(), Some("proxy_in"));
        assert_eq!(peer, None);
        assert_eq!(peer_ids, None);
    }

    #[test]
    fn extract_proxy_fields_role_and_peer_turn_id() {
        let (role, peer, peer_ids) = extract_proxy_fields(Some(
            r#"{"proxy":{"role":"proxy_out","peer_turn_id":"turn-42"}}"#.into(),
        ));
        assert_eq!(role.as_deref(), Some("proxy_out"));
        assert_eq!(peer.as_deref(), Some("turn-42"));
        assert_eq!(peer_ids, None);
    }

    #[test]
    fn extract_proxy_fields_peer_turn_ids_array() {
        let (role, _peer, peer_ids) = extract_proxy_fields(Some(
            r#"{"proxy":{"role":"proxy_in","peer_turn_ids":["turn-1","turn-2"]}}"#.into(),
        ));
        assert_eq!(role.as_deref(), Some("proxy_in"));
        assert_eq!(
            peer_ids,
            Some(vec!["turn-1".to_string(), "turn-2".to_string()])
        );
    }

    #[test]
    fn extract_proxy_fields_handles_sweeper_patch_shape() {
        // The real patch the pair sweeper writes via update_trace_metadata:
        // {"proxy":{"role":...,"pair_id":...,"peer_turn_id":...,"peer_turn_ids":[...]}}.
        let raw = r#"{"proxy":{"role":"proxy_in","pair_id":"pair-7","peer_turn_id":"turn-out","peer_turn_ids":["x","y"]}}"#;
        let (role, peer, peer_ids) = extract_proxy_fields(Some(raw.into()));
        assert_eq!(role.as_deref(), Some("proxy_in"));
        assert_eq!(peer.as_deref(), Some("turn-out"));
        assert_eq!(peer_ids, Some(vec!["x".to_string(), "y".to_string()]));
        // pair_id is not surfaced by this helper (only role + peer_turn_id[s]).
    }

    #[test]
    fn extract_proxy_fields_peer_turn_ids_not_array_is_none() {
        // A non-array peer_turn_ids (e.g. a string) yields None, not a crash.
        let (_role, _peer, peer_ids) = extract_proxy_fields(Some(
            r#"{"proxy":{"role":"proxy_in","peer_turn_ids":"oops"}}"#.into(),
        ));
        assert_eq!(peer_ids, None);
    }

    #[test]
    fn turn_row_select_lists_span_ids_as_micros() {
        // The read-modify-write SELECT must surface the two DateTime64(6) cols
        // as i64 micros (via toUnixTimestamp64Micro) so they deserialize into
        // TurnRow's i64 fields and re-insert round-trip. This is a compile-time
        // invariant of the constant; the test pins the two aliases.
        assert!(TURN_ROW_SELECT.contains("toUnixTimestamp64Micro(start_time) AS start_time"));
        assert!(TURN_ROW_SELECT.contains("toUnixTimestamp64Micro(end_time) AS end_time"));
        // span_ids read as the raw JSON String column (no transform).
        assert!(TURN_ROW_SELECT.contains("span_ids"));
        // _version read back so it can be bumped on re-insert.
        assert!(TURN_ROW_SELECT.contains("_version"));
    }

    #[test]
    fn traces_valid_sort_fields_is_whitelisted() {
        for &known in TRACES_VALID_SORT_FIELDS {
            assert!(known.chars().all(|c| c.is_alphanumeric() || c == '_'));
        }
        assert!(TRACES_VALID_SORT_FIELDS.contains(&"start_time"));
        assert!(TRACES_VALID_SORT_FIELDS.contains(&"call_count"));
        assert!(!TRACES_VALID_SORT_FIELDS.contains(&"bogus"));
    }

    fn traces_query() -> TracesQuery {
        TracesQuery {
            time_range: TimeRange { start_us: 100, end_us: 200 },
            filter: DimensionFilter::default(),
            client_ips: vec![],
            server_ports: vec![],
            statuses: vec![],
            agent_kinds: vec![],
            sort_by: "start_time".into(),
            sort_order: "desc".into(),
            page: 1,
            page_size: 10,
            include_proxy_hops: false,
        }
    }

    #[test]
    fn traces_where_sql_default_hides_proxy_hops() {
        // include_proxy_hops = false (default) appends the proxy exclusion.
        let s = traces_where_sql(&traces_query());
        assert!(s.starts_with("start_time >= fromUnixTimestamp64Micro(100)"));
        assert!(s.contains("start_time < fromUnixTimestamp64Micro(200)"));
        assert!(s.contains("NOT IN ('proxy_out', 'mirror_secondary')"));
    }

    #[test]
    fn traces_where_sql_include_proxy_hops_omits_exclusion() {
        let q = TracesQuery {
            include_proxy_hops: true,
            ..traces_query()
        };
        assert!(!traces_where_sql(&q).contains("NOT IN ('proxy_out'"));
    }

    #[test]
    fn traces_where_sql_models_uses_hasany_json_extract() {
        let q = TracesQuery {
            filter: DimensionFilter {
                models: vec!["gpt-4".into()],
                ..Default::default()
            },
            ..traces_query()
        };
        let s = traces_where_sql(&q);
        // models_used is a JSON-array String → hasAny(JSONExtract(..., 'Array(String)'), [...]).
        assert!(s.contains("hasAny(JSONExtract(coalesce(models_used, '[]'), 'Array(String)'), ['gpt-4'])"));
    }

    #[test]
    fn traces_where_sql_server_ports_uses_in_subquery_not_join() {
        // traces has no server_port → resolve the turn's first call_id against
        // spans via an uncorrelated IN-subquery (NOT a JOIN). Assert the shape
        // and that no literal "JOIN" keyword is introduced.
        let q = TracesQuery {
            server_ports: vec![8080, 443],
            ..traces_query()
        };
        let s = traces_where_sql(&q);
        assert!(s.contains("arrayElement(JSONExtract(span_ids, 'Array(String)'), 1) IN"));
        assert!(s.contains("SELECT id FROM spans WHERE server_port IN (8080, 443)"));
        assert!(!s.to_lowercase().contains(" join "));
        assert!(!s.contains(" JOIN "));
    }

    #[test]
    fn traces_where_sql_combines_dimension_filters() {
        let q = TracesQuery {
            filter: DimensionFilter {
                wire_apis: vec!["openai-chat".into()],
                server_ips: vec!["10.0.0.2".into()],
                ..Default::default()
            },
            statuses: vec!["complete".into()],
            agent_kinds: vec!["claude-cli".into()],
            client_ips: vec!["10.0.0.1".into()],
            ..traces_query()
        };
        let s = traces_where_sql(&q);
        assert!(s.contains("wire_api IN ('openai-chat')"));
        assert!(s.contains("server_ip IN ('10.0.0.2')"));
        assert!(s.contains("status IN ('complete')"));
        assert!(s.contains("agent_kind IN ('claude-cli')"));
        assert!(s.contains("client_ip IN ('10.0.0.1')"));
        assert!(!s.starts_with(" AND"));
        assert!(!s.ends_with("AND "));
    }

    #[test]
    fn traces_where_sql_escapes_user_lists() {
        let q = TracesQuery {
            filter: DimensionFilter {
                wire_apis: vec!["a'b".into()],
                ..Default::default()
            },
            ..traces_query()
        };
        // A quote in a wire_api value is doubled (no breakout).
        assert!(traces_where_sql(&q).contains("wire_api IN ('a''b')"));
    }
}

#[derive(Row, Deserialize)]
struct TurnListRow {
    turn_id: String,
    source_id: String,
    session_id: String,
    start_time_ms: i64,
    end_time_ms: i64,
    duration_ms: u64,
    wire_api: String,
    agent_kind: String,
    models_used: Option<String>,
    call_count: u32,
    total_input_tokens: u64,
    total_output_tokens: u64,
    status: String,
    final_finish_reason: Option<String>,
    user_input_preview: Option<String>,
    final_answer_preview: Option<String>,
    client_ip: String,
    server_ip: String,
    metadata: Option<String>,
    tool_surfaces_json: Option<String>,
    tool_call_total: u32,
    agent_topology: Option<String>,
    suspicious_skills_json: Option<String>,
}

#[derive(Row, Deserialize)]
struct TraceDetailRow {
    turn_id: String,
    source_id: String,
    session_id: String,
    wire_api: String,
    agent_kind: String,
    start_time_ms: i64,
    end_time_ms: i64,
    duration_ms: u64,
    call_count: u32,
    models_used: Option<String>,
    subagents_used: Option<String>,
    total_input_tokens: u64,
    total_output_tokens: u64,
    total_cache_read_input_tokens: u64,
    total_cache_creation_input_tokens: u64,
    total_cost_usd: Option<f64>,
    status: String,
    final_finish_reason: Option<String>,
    user_input_preview: Option<String>,
    user_call_id: Option<String>,
    final_answer_preview: Option<String>,
    final_call_id: Option<String>,
    span_ids: String,
    metadata: Option<String>,
    client_ip: String,
    server_ip: String,
    tool_surfaces_json: Option<String>,
    tool_call_total: u32,
    agent_topology: Option<String>,
    suspicious_skills_json: Option<String>,
}

#[derive(Row, Deserialize)]
struct PairCandidateRow {
    turn_id: String,
    session_id: String,
    agent_kind: String,
    wire_api: String,
    start_time_us: i64,
    end_time_us: i64,
    call_count: u32,
    total_input_tokens: u64,
    total_output_tokens: u64,
    final_finish_reason: Option<String>,
    models_used: Option<String>,
    client_ip: String,
    server_ip: String,
}

#[derive(Row, Deserialize)]
struct CountRow {
    n: u64,
}

/// Valid `sort_by` fields for `query_traces`. Hoisted to module scope so the
/// reject-unknown-sort path is unit-testable without a live client (the value
/// is interpolated into `ORDER BY`). Mirrors the DuckDB whitelist.
const TRACES_VALID_SORT_FIELDS: &[&str] = &[
    "start_time",
    "end_time",
    "duration_ms",
    "call_count",
    "total_input_tokens",
    "total_output_tokens",
];

/// Build the `query_traces` WHERE clause: a half-open `start_time` time range
/// AND-ed with every present dimension + per-call filter. Extracted as a pure
/// fn so the escaping / IN-list / JSON-array / IN-subquery / proxy-hop
/// assembly is unit-testable without a live server. The `server_ports` filter
/// uses an uncorrelated IN-subquery (NOT a JOIN) because `traces` carries no
/// `server_port`; the proxy-hop exclusion hides sweeper-folded hops.
pub(crate) fn traces_where_sql(query: &TracesQuery) -> String {
    let mut where_parts = vec![time_where(
        "start_time",
        query.time_range.start_us,
        query.time_range.end_us,
    )];
    if !query.filter.wire_apis.is_empty() {
        where_parts.push(format!("wire_api IN ({})", sql_in_list(&query.filter.wire_apis)));
    }
    if !query.filter.models.is_empty() {
        // models_used is a JSON-array String; match if any requested model is
        // present (DuckDB list_has_any → ClickHouse hasAny).
        where_parts.push(format!(
            "hasAny(JSONExtract(coalesce(models_used, '[]'), 'Array(String)'), [{}])",
            sql_in_list(&query.filter.models)
        ));
    }
    if !query.statuses.is_empty() {
        where_parts.push(format!("status IN ({})", sql_in_list(&query.statuses)));
    }
    if !query.agent_kinds.is_empty() {
        where_parts.push(format!("agent_kind IN ({})", sql_in_list(&query.agent_kinds)));
    }
    if !query.client_ips.is_empty() {
        where_parts.push(format!("client_ip IN ({})", sql_in_list(&query.client_ips)));
    }
    if !query.server_ports.is_empty() {
        // traces has no server_port; resolve via the turn's first call_id
        // against spans. ClickHouse can't do the DuckDB correlated EXISTS, so
        // use an uncorrelated IN-subquery (still not a JOIN): the turn's first
        // call_id ∈ { calls on those ports }.
        let ports: Vec<String> = query.server_ports.iter().map(|p| p.to_string()).collect();
        where_parts.push(format!(
            "arrayElement(JSONExtract(span_ids, 'Array(String)'), 1) IN \
             (SELECT id FROM spans WHERE server_port IN ({}))",
            ports.join(", ")
        ));
    }
    if !query.filter.server_ips.is_empty() {
        where_parts.push(format!("server_ip IN ({})", sql_in_list(&query.filter.server_ips)));
    }
    if !query.include_proxy_hops {
        // Hide the sweeper-folded hops. JSONExtractString returns '' when
        // absent, and '' NOT IN (...) is true, so direct turns +
        // proxy_in/mirror_primary stay visible.
        where_parts.push(
            "JSONExtractString(coalesce(metadata, ''), 'proxy', 'role') \
             NOT IN ('proxy_out', 'mirror_secondary')"
                .to_string(),
        );
    }
    where_parts.join(" AND ")
}

impl ClickHouseBackend {
    pub(crate) async fn write_traces(&self, turns: Vec<Trace>) -> Result<()> {
        let rows: Vec<TurnRow> = turns.into_iter().map(TurnRow::from).collect();
        insert_all!(self.client, "traces", TurnRow, rows);
        Ok(())
    }

    pub(crate) async fn query_traces(&self, query: &TracesQuery) -> Result<TracesPage> {
        if !TRACES_VALID_SORT_FIELDS.contains(&query.sort_by.as_str()) {
            return Err(AppError::Storage(format!(
                "invalid sort_by field: {}",
                query.sort_by
            )));
        }
        let sort_order = crate::calls::resolve_sort_order(&query.sort_order);

        let where_sql = traces_where_sql(query);

        let total = self
            .client
            .query(&format!(
                "SELECT count() AS n FROM traces FINAL WHERE {where_sql}"
            ))
            .fetch_one::<CountRow>()
            .await
            .map_err(|e| ch_err("query_traces count", e))?
            .n;

        let offset = (query.page.saturating_sub(1)) as u64 * query.page_size as u64;
        let items_sql = format!(
            "SELECT turn_id, source_id, session_id, \
             toUnixTimestamp64Milli(start_time) AS start_time_ms, \
             toUnixTimestamp64Milli(end_time) AS end_time_ms, \
             duration_ms, wire_api, agent_kind, models_used, call_count, \
             total_input_tokens, total_output_tokens, status, final_finish_reason, \
             user_input_preview, final_answer_preview, client_ip, server_ip, metadata, \
             tool_surfaces_json, tool_call_total, agent_topology, suspicious_skills_json \
             FROM traces FINAL WHERE {where_sql} \
             ORDER BY {} {sort_order} LIMIT {} OFFSET {offset}",
            query.sort_by, query.page_size,
        );
        let rows = self
            .client
            .query(&items_sql)
            .fetch_all::<TurnListRow>()
            .await
            .map_err(|e| ch_err("query_traces items", e))?;

        let items = rows
            .into_iter()
            .map(|r| {
                let models_used = parse_json_string_list(r.models_used.as_deref());
                let primary_model = models_used.first().cloned();
                let (proxy_role, proxy_peer_turn_id, proxy_peer_turn_ids) =
                    extract_proxy_fields(r.metadata);
                let tool_surfaces = parse_json_string_list(r.tool_surfaces_json.as_deref());
                let suspicious_skills: Vec<serde_json::Value> = r
                    .suspicious_skills_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                TraceListItem {
                    turn_id: r.turn_id,
                    source_id: r.source_id,
                    session_id: r.session_id,
                    start_time: r.start_time_ms,
                    end_time: r.end_time_ms,
                    duration_ms: r.duration_ms,
                    wire_api: r.wire_api,
                    agent_kind: r.agent_kind,
                    client_ip: r.client_ip,
                    server_ip: r.server_ip,
                    primary_model,
                    models_used,
                    call_count: r.call_count,
                    total_input_tokens: r.total_input_tokens,
                    total_output_tokens: r.total_output_tokens,
                    status: r.status,
                    final_finish_reason: r.final_finish_reason,
                    user_input_preview: r.user_input_preview,
                    final_answer_preview: r.final_answer_preview,
                    proxy_role,
                    proxy_peer_turn_id,
                    proxy_peer_turn_ids,
                    tool_surfaces,
                    tool_call_total: r.tool_call_total,
                    agent_topology: r.agent_topology,
                    suspicious_skills,
                }
            })
            .collect();
        Ok(TracesPage { total, items })
    }

    pub(crate) async fn query_trace_by_id(&self, turn_id: &str) -> Result<Option<TraceDetail>> {
        let sql = format!(
            "SELECT turn_id, source_id, session_id, wire_api, agent_kind, \
             toUnixTimestamp64Milli(start_time) AS start_time_ms, \
             toUnixTimestamp64Milli(end_time) AS end_time_ms, \
             duration_ms, call_count, models_used, subagents_used, \
             total_input_tokens, total_output_tokens, \
             total_cache_read_input_tokens, total_cache_creation_input_tokens, \
             total_cost_usd, status, final_finish_reason, \
             user_input_preview, user_call_id, final_answer_preview, final_call_id, \
             span_ids, metadata, client_ip, server_ip, \
             tool_surfaces_json, tool_call_total, agent_topology, suspicious_skills_json \
             FROM traces FINAL WHERE turn_id = '{}' LIMIT 1",
            escape_str(turn_id)
        );
        let row = self
            .client
            .query(&sql)
            .fetch_all::<TraceDetailRow>()
            .await
            .map_err(|e| ch_err("query_trace_by_id", e))?
            .into_iter()
            .next();
        let Some(r) = row else { return Ok(None) };

        let models_used = parse_json_string_list(r.models_used.as_deref());
        let subagents_used = parse_json_string_list(r.subagents_used.as_deref());
        let span_ids = parse_json_string_list(Some(&r.span_ids));
        let metadata = r
            .metadata
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
        let tool_surfaces = parse_json_string_list(r.tool_surfaces_json.as_deref());
        let suspicious_skills: Vec<serde_json::Value> = r
            .suspicious_skills_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        // Divergence from DuckDB: full user_input / final_answer would require
        // re-running the agent profile extractor over the referenced call
        // bodies (the DuckDB path's `extract_full_text`). We surface the stored
        // previews best-effort; truncated previews (ending `…`) stay truncated.
        Ok(Some(TraceDetail {
            turn_id: r.turn_id,
            source_id: r.source_id,
            session_id: r.session_id,
            wire_api: r.wire_api,
            agent_kind: r.agent_kind,
            client_ip: r.client_ip,
            server_ip: r.server_ip,
            start_time: r.start_time_ms,
            end_time: r.end_time_ms,
            duration_ms: r.duration_ms,
            call_count: r.call_count,
            models_used,
            subagents_used,
            total_input_tokens: r.total_input_tokens,
            total_output_tokens: r.total_output_tokens,
            total_cache_read_input_tokens: r.total_cache_read_input_tokens,
            total_cache_creation_input_tokens: r.total_cache_creation_input_tokens,
            total_cost_usd: r.total_cost_usd,
            status: r.status,
            final_finish_reason: r.final_finish_reason,
            user_call_id: r.user_call_id,
            user_input: r.user_input_preview,
            final_call_id: r.final_call_id,
            final_answer: r.final_answer_preview,
            span_ids,
            metadata,
            tool_surfaces,
            tool_call_total: r.tool_call_total,
            agent_topology: r.agent_topology,
            suspicious_skills,
        }))
    }

    pub(crate) async fn query_pair_candidates(
        &self,
        start_us: i64,
        end_us: i64,
    ) -> Result<Vec<PairCandidate>> {
        let ts_pred = time_where("start_time", start_us, end_us);
        let sql = format!(
            "SELECT turn_id, session_id, agent_kind, wire_api, \
             toUnixTimestamp64Micro(start_time) AS start_time_us, \
             toUnixTimestamp64Micro(end_time) AS end_time_us, \
             call_count, total_input_tokens, total_output_tokens, \
             final_finish_reason, models_used, client_ip, server_ip \
             FROM traces FINAL \
             WHERE {ts_pred} \
               AND JSONExtractString(coalesce(metadata, ''), 'proxy', 'role') = '' \
             ORDER BY start_time ASC"
        );
        let rows = self
            .client
            .query(&sql)
            .fetch_all::<PairCandidateRow>()
            .await
            .map_err(|e| ch_err("query_pair_candidates", e))?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let models = parse_json_string_list(r.models_used.as_deref());
                let primary_model = models.first().cloned();
                PairCandidate {
                    turn_id: r.turn_id,
                    session_id: r.session_id,
                    agent_kind: r.agent_kind,
                    wire_api: r.wire_api,
                    start_time_us: r.start_time_us,
                    end_time_us: r.end_time_us,
                    call_count: r.call_count,
                    total_input_tokens: r.total_input_tokens,
                    total_output_tokens: r.total_output_tokens,
                    final_finish_reason: r.final_finish_reason,
                    primary_model,
                    network_view: format!("{}->{}", r.client_ip, r.server_ip),
                }
            })
            .collect())
    }

    pub(crate) async fn update_trace_metadata(
        &self,
        turn_id: &str,
        patch: serde_json::Value,
    ) -> Result<()> {
        // Read-modify-write on ReplacingMergeTree: fetch the current full row
        // (FINAL = latest version), shallow-merge the patch into metadata, and
        // re-insert with a strictly-greater `_version` (wall-clock micros).
        let sql = format!(
            "SELECT {TURN_ROW_SELECT} FROM traces FINAL WHERE turn_id = '{}' LIMIT 1",
            escape_str(turn_id)
        );
        let existing = self
            .client
            .query(&sql)
            .fetch_all::<TurnRow>()
            .await
            .map_err(|e| ch_err("update_trace_metadata read", e))?
            .into_iter()
            .next();
        let Some(mut row) = existing else {
            // Turn not present yet — the sweeper races finalization; drop.
            return Ok(());
        };

        let mut base = row
            .metadata
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if !base.is_object() {
            base = serde_json::json!({});
        }
        if let (Some(obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        row.metadata = Some(base.to_string());
        row._version = now_micros();

        insert_all!(self.client, "traces", TurnRow, vec![row]);
        Ok(())
    }
}
