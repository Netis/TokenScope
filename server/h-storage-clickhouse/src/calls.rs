//! `spans` table I/O — write + paginated / by-id / by-id-list reads.

use clickhouse::Row;
use serde::Deserialize;

use h_common::error::Result;
use h_common::process::ProcessInfo;
use h_llm::model::LlmCall;
use h_storage::convert::{derive_tokens_estimated, parse_json_string_list};
use h_storage::query::*;

use crate::client::{ch_err, insert_all};
use crate::rows::CallRow;
use crate::sql::{escape_str, sql_in_list, time_where};
use crate::ClickHouseBackend;

const VALID_SORT_FIELDS: &[&str] = &[
    "request_time",
    "status_code",
    "ttft_ms",
    "e2e_latency_ms",
    "input_tokens",
    "output_tokens",
];

#[derive(Row, Deserialize)]
struct CountRow {
    n: u64,
}

/// Row shape for the paginated `query_spans` list (mirrors the DuckDB SELECT).
#[derive(Row, Deserialize)]
struct CallListRow {
    id: String,
    source_id: String,
    request_time_ms: i64,
    wire_api: String,
    model: String,
    status_code: Option<u16>,
    is_stream: bool,
    finish_reason: Option<String>,
    ttft_ms: Option<f64>,
    e2e_latency_ms: Option<f64>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    client_ip: String,
    server_ip: String,
    server_port: u16,
    request_path: String,
    response_body: Option<String>,
    is_agent_request: bool,
    tool_surface: Option<String>,
    agent_topology: Option<String>,
    tool_call_count: u32,
    tool_names_json: Option<String>,
    process_pid: Option<u32>,
    process_comm: Option<String>,
    process_exe: Option<String>,
}

#[derive(Row, Deserialize)]
struct SpanDetailRow {
    id: String,
    source_id: String,
    request_time_ms: i64,
    response_time_ms: Option<i64>,
    complete_time_ms: Option<i64>,
    wire_api: String,
    model: String,
    api_type: String,
    is_stream: bool,
    request_path: String,
    status_code: Option<u16>,
    finish_reason: Option<String>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    total_tokens: Option<u32>,
    ttft_ms: Option<f64>,
    e2e_latency_ms: Option<f64>,
    response_id: Option<String>,
    client_ip: String,
    client_port: u16,
    server_ip: String,
    server_port: u16,
    request_body: Option<String>,
    response_body: Option<String>,
    request_headers: String,
    response_headers: String,
    is_agent_request: bool,
    tool_surface: Option<String>,
    agent_topology: Option<String>,
    tool_call_count: u32,
    tool_names_json: Option<String>,
    process_pid: Option<u32>,
    process_comm: Option<String>,
    process_exe: Option<String>,
}

#[derive(Row, Deserialize)]
struct TurnCallRow {
    id: String,
    request_time_ms: i64,
    response_time_ms: Option<i64>,
    complete_time_ms: Option<i64>,
    wire_api: String,
    model: String,
    status_code: Option<u16>,
    is_stream: bool,
    finish_reason: Option<String>,
    ttft_ms: Option<f64>,
    e2e_latency_ms: Option<f64>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    request_path: String,
    client_ip: String,
    client_port: u16,
    server_ip: String,
    server_port: u16,
    request_body: Option<String>,
    response_body: Option<String>,
    request_headers: Option<String>,
    response_headers: Option<String>,
}

impl ClickHouseBackend {
    pub(crate) async fn write_spans(&self, calls: Vec<LlmCall>) -> Result<()> {
        let rows: Vec<CallRow> = calls.into_iter().map(CallRow::from).collect();
        insert_all!(self.client, "spans", CallRow, rows);
        Ok(())
    }

    pub(crate) async fn query_spans(&self, query: &SpansQuery) -> Result<SpansPage> {
        if !VALID_SORT_FIELDS.contains(&query.sort_by.as_str()) {
            return Err(h_common::error::AppError::Storage(format!(
                "invalid sort_by field: {}",
                query.sort_by
            )));
        }
        let sort_order = resolve_sort_order(&query.sort_order);

        let where_sql = spans_where_sql(query);

        let total = self
            .client
            .query(&format!("SELECT count() AS n FROM spans WHERE {where_sql}"))
            .fetch_one::<CountRow>()
            .await
            .map_err(|e| ch_err("query_spans count", e))?
            .n;

        let offset = (query.page.saturating_sub(1)) as u64 * query.page_size as u64;
        let items_sql = format!(
            "SELECT id, source_id, toUnixTimestamp64Milli(request_time) AS request_time_ms, \
             wire_api, model, status_code, is_stream, finish_reason, ttft_ms, e2e_latency_ms, \
             input_tokens, output_tokens, client_ip, server_ip, server_port, request_path, \
             response_body, is_agent_request, tool_surface, agent_topology, tool_call_count, \
             tool_names_json, process_pid, process_comm, process_exe \
             FROM spans WHERE {where_sql} \
             ORDER BY {} {sort_order} LIMIT {} OFFSET {offset}",
            query.sort_by, query.page_size,
        );
        let rows = self
            .client
            .query(&items_sql)
            .fetch_all::<CallListRow>()
            .await
            .map_err(|e| ch_err("query_spans items", e))?;

        let items = rows.into_iter().map(call_list_item).collect();
        Ok(SpansPage { total, items })
    }

    pub(crate) async fn query_span_by_id(&self, id: &str) -> Result<Option<SpanDetail>> {
        let sql = format!(
            "SELECT id, source_id, \
             toUnixTimestamp64Milli(request_time) AS request_time_ms, \
             toUnixTimestamp64Milli(response_time) AS response_time_ms, \
             toUnixTimestamp64Milli(complete_time) AS complete_time_ms, \
             wire_api, model, api_type, is_stream, request_path, status_code, finish_reason, \
             input_tokens, output_tokens, total_tokens, ttft_ms, e2e_latency_ms, response_id, \
             client_ip, client_port, server_ip, server_port, request_body, response_body, \
             request_headers, response_headers, is_agent_request, tool_surface, agent_topology, \
             tool_call_count, tool_names_json, process_pid, process_comm, process_exe \
             FROM spans WHERE id = '{}' LIMIT 1",
            escape_str(id)
        );
        let row = self
            .client
            .query(&sql)
            .fetch_all::<SpanDetailRow>()
            .await
            .map_err(|e| ch_err("query_span_by_id", e))?
            .into_iter()
            .next();
        Ok(row.map(call_detail))
    }

    pub(crate) async fn query_trace_spans(
        &self,
        turn_id: &str,
        include_bodies: bool,
    ) -> Result<Vec<TraceSpanItem>> {
        // No-JOIN two-step: resolve the turn's ordered span_ids, then fetch.
        let span_ids = self.turn_span_ids(turn_id).await?;
        self.read_calls_by_ids(&span_ids, include_bodies).await
    }

    pub(crate) async fn query_spans_by_ids(
        &self,
        span_ids: &[String],
        include_bodies: bool,
    ) -> Result<Vec<TraceSpanItem>> {
        self.read_calls_by_ids(span_ids, include_bodies).await
    }

    /// Read `traces.span_ids` (JSON array) for one turn. `FINAL` so the
    /// latest ReplacingMergeTree version wins.
    async fn turn_span_ids(&self, turn_id: &str) -> Result<Vec<String>> {
        #[derive(Row, Deserialize)]
        struct CallIdsRow {
            span_ids: String,
        }
        let sql = format!(
            "SELECT span_ids FROM traces FINAL WHERE turn_id = '{}' LIMIT 1",
            escape_str(turn_id)
        );
        let row = self
            .client
            .query(&sql)
            .fetch_all::<CallIdsRow>()
            .await
            .map_err(|e| ch_err("turn_span_ids", e))?
            .into_iter()
            .next();
        Ok(row
            .map(|r| parse_json_string_list(Some(&r.span_ids)))
            .unwrap_or_default())
    }

    /// Shared "fetch calls by id list" — used by `query_trace_spans` (ids from
    /// the persisted `traces.span_ids`) and `query_spans_by_ids` (ids from
    /// the in-memory active-turn registry). Calls not yet flushed simply don't
    /// return. Lite mode (`include_bodies = false`) selects NULL for the four
    /// heavy body/header fields.
    async fn read_calls_by_ids(
        &self,
        span_ids: &[String],
        include_bodies: bool,
    ) -> Result<Vec<TraceSpanItem>> {
        if span_ids.is_empty() {
            return Ok(Vec::new());
        }
        let body_columns = if include_bodies {
            // request_body/response_body are Nullable; headers are non-null
            // String columns — toNullable() so the row type is uniform across
            // full + lite mode (lite selects CAST(NULL AS Nullable(String))).
            "request_body, response_body, \
             toNullable(request_headers) AS request_headers, \
             toNullable(response_headers) AS response_headers"
        } else {
            "CAST(NULL AS Nullable(String)) AS request_body, \
             CAST(NULL AS Nullable(String)) AS response_body, \
             CAST(NULL AS Nullable(String)) AS request_headers, \
             CAST(NULL AS Nullable(String)) AS response_headers"
        };
        let sql = format!(
            "SELECT id, \
             toUnixTimestamp64Milli(request_time) AS request_time_ms, \
             toUnixTimestamp64Milli(response_time) AS response_time_ms, \
             toUnixTimestamp64Milli(complete_time) AS complete_time_ms, \
             wire_api, model, status_code, is_stream, finish_reason, ttft_ms, e2e_latency_ms, \
             input_tokens, output_tokens, request_path, client_ip, client_port, server_ip, \
             server_port, {body_columns} \
             FROM spans WHERE id IN ({}) \
             ORDER BY request_time ASC, complete_time ASC",
            sql_in_list(span_ids),
        );
        let rows = self
            .client
            .query(&sql)
            .fetch_all::<TurnCallRow>()
            .await
            .map_err(|e| ch_err("read_calls_by_ids", e))?;

        let items = rows
            .into_iter()
            .enumerate()
            .map(|(i, r)| {
                let tokens_estimated = derive_tokens_estimated(
                    r.input_tokens,
                    r.output_tokens,
                    r.response_body.as_deref(),
                );
                TraceSpanItem {
                    id: r.id,
                    sequence: (i as u32) + 1,
                    request_time: r.request_time_ms,
                    response_time: r.response_time_ms,
                    complete_time: r.complete_time_ms,
                    wire_api: r.wire_api,
                    model: r.model,
                    status_code: r.status_code,
                    is_stream: r.is_stream,
                    finish_reason: r.finish_reason,
                    ttft_ms: r.ttft_ms,
                    e2e_latency_ms: r.e2e_latency_ms,
                    input_tokens: r.input_tokens,
                    output_tokens: r.output_tokens,
                    tokens_estimated,
                    request_path: r.request_path,
                    client_ip: r.client_ip,
                    client_port: r.client_port,
                    server_ip: r.server_ip,
                    server_port: r.server_port,
                    request_body: r.request_body,
                    response_body: r.response_body,
                    request_headers: r.request_headers,
                    response_headers: r.response_headers,
                }
            })
            .collect();
        Ok(items)
    }
}

/// Join numeric values into a comma list for `IN (...)` (no quoting needed).
fn join_nums<T: std::fmt::Display>(values: &[T]) -> String {
    values
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Normalize a client-supplied sort direction to the SQL literal. Anything
/// other than an ASCII-case-insensitive `ASC` (including the empty / missing
/// value the API defaults to `"desc"` for) collapses to `DESC`, so a malformed
/// `sort_order` can never inject a non-keyword into the ORDER BY clause.
pub(crate) fn resolve_sort_order(sort_order: &str) -> &'static str {
    if sort_order.eq_ignore_ascii_case("ASC") {
        "ASC"
    } else {
        "DESC"
    }
}

/// Build the `query_spans` WHERE clause: a half-open `request_time` time range
/// AND-ed with every present dimension filter. Extracted as a pure fn so the
/// escaping / IN-list / LIKE assembly is unit-testable without a live server.
/// Timestamps and numeric ports are interpolated (values we control); user
/// string lists go through `sql_in_list`'s backslash-aware single-quote
/// escaping; the `LIKE` substring goes through `escape_str` (which deliberately
/// leaves `%` / `_` so substring semantics survive).
pub(crate) fn spans_where_sql(query: &SpansQuery) -> String {
    let mut where_parts =
        vec![time_where("request_time", query.time_range.start_us, query.time_range.end_us)];
    if !query.filter.wire_apis.is_empty() {
        where_parts.push(format!("wire_api IN ({})", sql_in_list(&query.filter.wire_apis)));
    }
    if !query.filter.models.is_empty() {
        where_parts.push(format!("model IN ({})", sql_in_list(&query.filter.models)));
    }
    if !query.filter.server_ips.is_empty() {
        where_parts.push(format!("server_ip IN ({})", sql_in_list(&query.filter.server_ips)));
    }
    if !query.status_codes.is_empty() {
        where_parts.push(format!("status_code IN ({})", join_nums(&query.status_codes)));
    }
    if !query.finish_reasons.is_empty() {
        where_parts.push(format!("finish_reason IN ({})", sql_in_list(&query.finish_reasons)));
    }
    if !query.client_ips.is_empty() {
        where_parts.push(format!("client_ip IN ({})", sql_in_list(&query.client_ips)));
    }
    if !query.server_ports.is_empty() {
        where_parts.push(format!("server_port IN ({})", join_nums(&query.server_ports)));
    }
    if let Some(substr) = query
        .request_path_contains
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        where_parts.push(format!("request_path LIKE '%{}%'", escape_str(substr)));
    }
    if let Some(stream) = query.is_stream {
        where_parts.push(format!("is_stream = {}", if stream { 1 } else { 0 }));
    }
    where_parts.join(" AND ")
}

/// Build `Option<ProcessInfo>` from the three nullable `process_*` columns.
/// `None` exactly when `pid` is NULL (passive-tap rows).
fn row_process(pid: Option<u32>, comm: Option<String>, exe: Option<String>) -> Option<ProcessInfo> {
    pid.map(|pid| ProcessInfo {
        pid,
        comm: comm.unwrap_or_default(),
        exe,
    })
}

fn call_list_item(r: CallListRow) -> SpanListItem {
    let tokens_estimated =
        derive_tokens_estimated(r.input_tokens, r.output_tokens, r.response_body.as_deref());
    let tool_names = parse_json_string_list(r.tool_names_json.as_deref());
    let process = row_process(r.process_pid, r.process_comm, r.process_exe);
    SpanListItem {
        id: r.id,
        source_id: r.source_id,
        request_time: r.request_time_ms,
        wire_api: r.wire_api,
        model: r.model,
        status_code: r.status_code,
        is_stream: r.is_stream,
        finish_reason: r.finish_reason,
        ttft_ms: r.ttft_ms,
        e2e_latency_ms: r.e2e_latency_ms,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        tokens_estimated,
        client_ip: r.client_ip,
        server_ip: r.server_ip,
        server_port: r.server_port,
        request_path: r.request_path,
        is_agent_request: r.is_agent_request,
        tool_surface: r.tool_surface,
        agent_topology: r.agent_topology,
        tool_call_count: r.tool_call_count,
        tool_names,
        process,
    }
}

fn call_detail(r: SpanDetailRow) -> SpanDetail {
    let tokens_estimated =
        derive_tokens_estimated(r.input_tokens, r.output_tokens, r.response_body.as_deref());
    let tool_names = parse_json_string_list(r.tool_names_json.as_deref());
    let process = row_process(r.process_pid, r.process_comm, r.process_exe);
    SpanDetail {
        id: r.id,
        source_id: r.source_id,
        request_time: r.request_time_ms,
        response_time: r.response_time_ms,
        complete_time: r.complete_time_ms,
        wire_api: r.wire_api,
        model: r.model,
        api_type: r.api_type,
        is_stream: r.is_stream,
        request_path: r.request_path,
        status_code: r.status_code,
        finish_reason: r.finish_reason,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        total_tokens: r.total_tokens,
        tokens_estimated,
        ttft_ms: r.ttft_ms,
        e2e_latency_ms: r.e2e_latency_ms,
        response_id: r.response_id,
        client_ip: r.client_ip,
        client_port: r.client_port,
        server_ip: r.server_ip,
        server_port: r.server_port,
        request_body: r.request_body,
        response_body: r.response_body,
        request_headers: Some(r.request_headers),
        response_headers: Some(r.response_headers),
        is_agent_request: r.is_agent_request,
        tool_surface: r.tool_surface,
        agent_topology: r.agent_topology,
        tool_call_count: r.tool_call_count,
        tool_names,
        process,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list_row(response_body: Option<String>) -> CallListRow {
        CallListRow {
            id: "call-1".into(),
            source_id: "src-0".into(),
            request_time_ms: 1_700_000_000_000,
            wire_api: "openai-chat".into(),
            model: "gpt-4".into(),
            status_code: Some(200),
            is_stream: true,
            finish_reason: Some("stop".into()),
            ttft_ms: Some(500.0),
            e2e_latency_ms: Some(1000.0),
            input_tokens: Some(100),
            output_tokens: Some(50),
            client_ip: "10.0.0.1".into(),
            server_ip: "10.0.0.2".into(),
            server_port: 8080,
            request_path: "/v1/chat/completions".into(),
            response_body,
            is_agent_request: false,
            tool_surface: None,
            agent_topology: None,
            tool_call_count: 0,
            tool_names_json: Some(r#"["bash","grep"]"#.into()),
            process_pid: None,
            process_comm: None,
            process_exe: None,
        }
    }

    #[test]
    fn join_nums_renders_numeric_in_list() {
        assert_eq!(join_nums(&[8080u16, 443u16]), "8080, 443");
        assert_eq!(join_nums(&[200u16]), "200");
        assert_eq!(join_nums::<u16>(&[]), "");
    }

    #[test]
    fn row_process_none_when_pid_none() {
        assert_eq!(row_process(None, Some("node".into()), Some("/x".into())), None);
        // pid present → Some(ProcessInfo); comm defaults to "" when absent; exe pass-through.
        let p = row_process(Some(7), None, None).unwrap();
        assert_eq!(p.pid, 7);
        assert_eq!(p.comm, "");
        assert_eq!(p.exe, None);
        let p = row_process(Some(7), Some("node".into()), Some("/usr/bin/node".into())).unwrap();
        assert_eq!(p.comm, "node");
        assert_eq!(p.exe.as_deref(), Some("/usr/bin/node"));
    }

    #[test]
    fn call_list_item_maps_scalars_and_ms_timestamp() {
        let item = call_list_item(list_row(None));
        assert_eq!(item.id, "call-1");
        assert_eq!(item.source_id, "src-0");
        assert_eq!(item.request_time, 1_700_000_000_000);
        assert_eq!(item.wire_api, "openai-chat");
        assert_eq!(item.model, "gpt-4");
        assert_eq!(item.status_code, Some(200));
        assert!(item.is_stream);
        assert_eq!(item.finish_reason.as_deref(), Some("stop"));
        assert_eq!(item.ttft_ms, Some(500.0));
        assert_eq!(item.e2e_latency_ms, Some(1000.0));
        assert_eq!(item.input_tokens, Some(100));
        assert_eq!(item.output_tokens, Some(50));
        assert_eq!(item.client_ip, "10.0.0.1");
        assert_eq!(item.server_ip, "10.0.0.2");
        assert_eq!(item.server_port, 8080);
        assert_eq!(item.request_path, "/v1/chat/completions");
        assert!(!item.is_agent_request);
        assert_eq!(item.tool_names, vec!["bash".to_string(), "grep".to_string()]);
        assert_eq!(item.process, None);
    }

    #[test]
    fn call_list_item_tokens_estimated_follows_usage_block() {
        // Body with a positive usage block → wire tokens → estimated = false.
        let with_usage = list_row(Some(
            r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}"#.into(),
        ));
        assert!(!call_list_item(with_usage).tokens_estimated);

        // Body without a usage block → estimated = true.
        let no_usage = list_row(Some(r#"{"choices":[{"message":{"content":"hi"}}]}"#.into()));
        assert!(call_list_item(no_usage).tokens_estimated);

        // No body at all → estimated = true.
        assert!(call_list_item(list_row(None)).tokens_estimated);
    }

    #[test]
    fn call_list_item_zero_tokens_never_estimated() {
        let mut r = list_row(None);
        r.input_tokens = Some(0);
        r.output_tokens = Some(0);
        // Even with no body, zero tokens → not estimated.
        assert!(!call_list_item(r).tokens_estimated);
    }

    #[test]
    fn call_list_item_malformed_tool_names_json_degrades_to_empty() {
        let mut r = list_row(None);
        r.tool_names_json = Some("not-json".into());
        assert_eq!(call_list_item(r).tool_names, Vec::<String>::new());
    }

    fn detail_row(response_body: Option<String>) -> SpanDetailRow {
        SpanDetailRow {
            id: "call-1".into(),
            source_id: "src-0".into(),
            request_time_ms: 1_700_000_000_000,
            response_time_ms: Some(1_700_000_000_500),
            complete_time_ms: Some(1_700_000_001_000),
            wire_api: "openai-chat".into(),
            model: "gpt-4".into(),
            api_type: "chat".into(),
            is_stream: true,
            request_path: "/v1/chat/completions".into(),
            status_code: Some(200),
            finish_reason: Some("stop".into()),
            input_tokens: Some(100),
            output_tokens: Some(50),
            total_tokens: Some(150),
            ttft_ms: Some(500.0),
            e2e_latency_ms: Some(1000.0),
            response_id: Some("chatcmpl-x".into()),
            client_ip: "10.0.0.1".into(),
            client_port: 54321,
            server_ip: "10.0.0.2".into(),
            server_port: 8080,
            request_body: Some(r#"{"model":"gpt-4"}"#.into()),
            response_body,
            request_headers: r#"[["content-type","application/json"]]"#.into(),
            response_headers: r#"[["x-request-id","abc"]]"#.into(),
            is_agent_request: false,
            tool_surface: None,
            agent_topology: None,
            tool_call_count: 0,
            tool_names_json: Some("[]".into()),
            process_pid: Some(42),
            process_comm: Some("node".into()),
            process_exe: Some("/usr/bin/node".into()),
        }
    }

    #[test]
    fn call_detail_wraps_headers_in_some() {
        // SpanDetailRow.request_headers / response_headers are non-null String;
        // SpanDetail wraps them in Some(...) to match the API shape.
        let d = call_detail(detail_row(None));
        assert_eq!(d.id, "call-1");
        assert_eq!(d.response_time, Some(1_700_000_000_500));
        assert_eq!(d.complete_time, Some(1_700_000_001_000));
        assert_eq!(d.api_type, "chat");
        assert_eq!(d.total_tokens, Some(150));
        assert_eq!(d.response_id.as_deref(), Some("chatcmpl-x"));
        assert_eq!(d.client_port, 54321);
        assert_eq!(d.request_headers.as_deref(), Some(r#"[["content-type","application/json"]]"#));
        assert_eq!(d.response_headers.as_deref(), Some(r#"[["x-request-id","abc"]]"#));
        assert_eq!(d.request_body.as_deref(), Some(r#"{"model":"gpt-4"}"#));
        // process built from the three process_* columns.
        assert_eq!(
            d.process.as_ref().unwrap(),
            &ProcessInfo {
                pid: 42,
                comm: "node".into(),
                exe: Some("/usr/bin/node".into()),
            }
        );
    }

    #[test]
    fn call_detail_tokens_estimated_follows_usage_block() {
        let with_usage = detail_row(Some(
            r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}"#.into(),
        ));
        assert!(!call_detail(with_usage).tokens_estimated);
        let no_usage = detail_row(Some(r#"{"choices":[]}"#.into()));
        assert!(call_detail(no_usage).tokens_estimated);
    }

    #[test]
    fn valid_sort_fields_is_whitelisted() {
        // The `query_spans` sort_by is interpolated into ORDER BY, so an unknown
        // field must be rejected up front — the whitelist is the gate.
        for &known in VALID_SORT_FIELDS {
            // every entry is a plain column name (no injection surface).
            assert!(known.chars().all(|c| c.is_alphanumeric() || c == '_'));
        }
        assert!(VALID_SORT_FIELDS.contains(&"request_time"));
        assert!(VALID_SORT_FIELDS.contains(&"ttft_ms"));
        assert!(!VALID_SORT_FIELDS.contains(&"bogus"));
    }

    fn spans_query() -> SpansQuery {
        SpansQuery {
            time_range: TimeRange { start_us: 100, end_us: 200 },
            filter: DimensionFilter::default(),
            status_codes: vec![],
            finish_reasons: vec![],
            client_ips: vec![],
            server_ports: vec![],
            request_path_contains: None,
            is_stream: None,
            sort_by: "request_time".into(),
            sort_order: "desc".into(),
            page: 1,
            page_size: 10,
        }
    }

    #[test]
    fn resolve_sort_order_normalizes() {
        assert_eq!(resolve_sort_order("asc"), "ASC");
        assert_eq!(resolve_sort_order("ASC"), "ASC");
        assert_eq!(resolve_sort_order("Asc"), "ASC");
        assert_eq!(resolve_sort_order("desc"), "DESC");
        assert_eq!(resolve_sort_order("DESC"), "DESC");
        // Anything non-ASC (including garbage / empty) collapses to DESC so a
        // malformed value can never inject a non-keyword into ORDER BY.
        assert_eq!(resolve_sort_order(""), "DESC");
        assert_eq!(resolve_sort_order("garbage; DROP"), "DESC");
    }

    #[test]
    fn spans_where_sql_is_time_range_only_by_default() {
        let s = spans_where_sql(&spans_query());
        assert_eq!(
            s,
            "request_time >= fromUnixTimestamp64Micro(100) \
             AND request_time < fromUnixTimestamp64Micro(200)"
        );
    }

    #[test]
    fn spans_where_sql_combines_all_filters() {
        let q = SpansQuery {
            filter: DimensionFilter {
                wire_apis: vec!["openai-chat".into()],
                models: vec!["gpt-4".into()],
                server_ips: vec!["10.0.0.2".into()],
                tool_surfaces: vec![],
            },
            status_codes: vec![429],
            finish_reasons: vec!["stop".into()],
            client_ips: vec!["10.0.0.1".into()],
            server_ports: vec![8080],
            request_path_contains: Some("chat/completions".into()),
            is_stream: Some(true),
            ..spans_query()
        };
        let s = spans_where_sql(&q);
        // Every filter appends an AND'd predicate in declaration order.
        assert!(s.contains("wire_api IN ('openai-chat')"));
        assert!(s.contains("model IN ('gpt-4')"));
        assert!(s.contains("server_ip IN ('10.0.0.2')"));
        assert!(s.contains("status_code IN (429)"));
        assert!(s.contains("finish_reason IN ('stop')"));
        assert!(s.contains("client_ip IN ('10.0.0.1')"));
        assert!(s.contains("server_port IN (8080)"));
        assert!(s.contains("request_path LIKE '%chat/completions%'"));
        assert!(s.contains("is_stream = 1"));
        // Joined by AND, no trailing/leading separator.
        assert!(!s.starts_with(" AND"));
        assert!(!s.ends_with("AND "));
    }

    #[test]
    fn spans_where_sql_like_escapes_quotes_not_wildcards() {
        let q = SpansQuery {
            request_path_contains: Some("a'b".into()),
            ..spans_query()
        };
        let s = spans_where_sql(&q);
        // The embedded quote is doubled (no breakout); the % wrappers come from
        // the format string, not the value.
        assert!(s.contains("request_path LIKE '%a''b%'"));
    }

    #[test]
    fn spans_where_sql_trims_and_ignores_empty_like_substring() {
        let q = SpansQuery {
            request_path_contains: Some("   ".into()),
            ..spans_query()
        };
        // A whitespace-only substring is trimmed to empty → no LIKE predicate.
        assert!(!spans_where_sql(&q).contains("LIKE"));
    }

    #[test]
    fn spans_where_sql_is_stream_false() {
        let q = SpansQuery {
            is_stream: Some(false),
            ..spans_query()
        };
        assert!(spans_where_sql(&q).contains("is_stream = 0"));
    }

    #[test]
    fn spans_where_sql_in_list_uses_backslash_escaping() {
        let q = SpansQuery {
            filter: DimensionFilter {
                models: vec![r"gpt\4".into()],
                ..Default::default()
            },
            ..spans_query()
        };
        // A backslash in a model value is doubled (ClickHouse-aware), keeping
        // the literal closed.
        assert!(spans_where_sql(&q).contains(r"model IN ('gpt\\4')"));
    }
}
