//! `http_exchanges` table I/O — write + by-id / paginated reads.

use clickhouse::Row;
use serde::Deserialize;

use h_common::error::Result;
use h_protocol::HttpExchange;
use h_storage::query::*;

use crate::client::insert_all;
use crate::rows::ExchangeRow;
use crate::sql::{escape_str, sql_in_list, time_where};
use crate::ClickHouseBackend;

/// Valid `sort_by` fields for `query_http_exchanges`, mirroring the DuckDB
/// backend. `duration_ms` is a derived expression; the others are plain
/// columns (`status` is the per-exchange status column).
const VALID_SORT_FIELDS: &[&str] = &["request_time", "status", "duration_ms"];

#[derive(Row, Deserialize)]
struct CountRow {
    n: u64,
}

/// Row shape for the by-id `query_http_exchange_by_id` detail SELECT. Field
/// names + order match the SELECT column aliases / order exactly so the
/// RowBinary validator is satisfied. Timestamps are read as microseconds via
/// `toUnixTimestamp64Micro`, matching `HttpExchangeDetail`'s µs i64 fields.
#[derive(Row, Deserialize)]
struct ExchangeDetailRow {
    id: String,
    source_id: String,
    client_ip: String,
    client_port: u16,
    server_ip: String,
    server_port: u16,
    method: String,
    uri: String,
    request_headers: String,
    request_body: Option<String>,
    status: Option<u16>,
    response_headers: String,
    response_body: Option<String>,
    is_sse: bool,
    sse_event_count: u32,
    sse_data_bytes: u64,
    request_time_us: i64,
    response_first_byte_time_us: Option<i64>,
    response_complete_time_us: Option<i64>,
}

/// Row shape for the paginated `query_http_exchanges` list SELECT. Mirrors the
/// DuckDB SELECT: `request_time` is milliseconds (`epoch_ms` → `toUnixTimestamp64Milli`),
/// and `duration_ms` is the derived complete−request gap in ms (NULL when incomplete).
#[derive(Row, Deserialize)]
struct ExchangeListRow {
    id: String,
    source_id: String,
    request_time_ms: i64,
    method: String,
    uri: String,
    client_ip: String,
    server_ip: String,
    server_port: u16,
    status: Option<u16>,
    is_sse: bool,
    duration_ms: Option<f64>,
}

impl ClickHouseBackend {
    pub(crate) async fn write_exchanges(&self, exchanges: Vec<HttpExchange>) -> Result<()> {
        let rows: Vec<ExchangeRow> = exchanges.into_iter().map(ExchangeRow::from).collect();
        insert_all!(self.client, "http_exchanges", ExchangeRow, rows);
        Ok(())
    }

    pub(crate) async fn query_http_exchange_by_id(
        &self,
        id: &str,
    ) -> Result<Option<HttpExchangeDetail>> {
        let sql = format!(
            "SELECT id, source_id, \
             client_ip, client_port, server_ip, server_port, \
             method, uri, \
             request_headers, request_body, \
             status, response_headers, response_body, is_sse, \
             sse_event_count, sse_data_bytes, \
             toUnixTimestamp64Micro(request_time) AS request_time_us, \
             toUnixTimestamp64Micro(response_first_byte_time) AS response_first_byte_time_us, \
             toUnixTimestamp64Micro(response_complete_time) AS response_complete_time_us \
             FROM http_exchanges WHERE id = '{}' LIMIT 1",
            escape_str(id)
        );
        let row = self
            .client
            .query(&sql)
            .fetch_all::<ExchangeDetailRow>()
            .await
            .map_err(|e| crate::client::ch_err("query_http_exchange_by_id", e))?
            .into_iter()
            .next();
        Ok(row.map(exchange_detail))
    }

    pub(crate) async fn query_http_exchanges(
        &self,
        query: &HttpExchangesQuery,
    ) -> Result<HttpExchangesPage> {
        if !VALID_SORT_FIELDS.contains(&query.sort_by.as_str()) {
            return Err(h_common::error::AppError::Storage(format!(
                "invalid sort_by field: {}",
                query.sort_by
            )));
        }
        let sort_order = crate::calls::resolve_sort_order(&query.sort_order);

        let where_sql = http_exchanges_where_sql(query);

        // Map virtual field → column/expression for ORDER BY. `duration_ms`
        // and `status` get `NULLS LAST` so incomplete (duration/status=None)
        // rows don't dominate a descending sort, matching the DuckDB backend.
        let order_expr = http_exchanges_order_expr(&query.sort_by);

        let total = self
            .client
            .query(&format!(
                "SELECT count() AS n FROM http_exchanges WHERE {where_sql}"
            ))
            .fetch_one::<CountRow>()
            .await
            .map_err(|e| crate::client::ch_err("query_http_exchanges count", e))?
            .n;

        let offset = (query.page.saturating_sub(1)) as u64 * query.page_size as u64;
        // `request_time` as ms (epoch_ms) and `duration_ms` as the complete−request
        // gap in ms (NULL when incomplete), mirroring the DuckDB list SELECT.
        let items_sql = format!(
            "SELECT id, source_id, \
             toUnixTimestamp64Milli(request_time) AS request_time_ms, \
             method, uri, client_ip, server_ip, server_port, \
             status, is_sse, \
             CASE WHEN response_complete_time IS NOT NULL \
                  THEN (toUnixTimestamp64Micro(response_complete_time) \
                        - toUnixTimestamp64Micro(request_time)) / 1000.0 \
                  ELSE NULL END AS duration_ms \
             FROM http_exchanges WHERE {where_sql} \
             ORDER BY {order_expr} {sort_order} \
             LIMIT {} OFFSET {offset}",
            query.page_size,
        );
        let rows = self
            .client
            .query(&items_sql)
            .fetch_all::<ExchangeListRow>()
            .await
            .map_err(|e| crate::client::ch_err("query_http_exchanges items", e))?;

        let items = rows.into_iter().map(exchange_list_item).collect();
        Ok(HttpExchangesPage { total, items })
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

/// Build the `query_http_exchanges` WHERE clause: a half-open `request_time`
/// time range AND-ed with every present filter. Extracted as a pure fn so the
/// escaping / IN-list / LIKE assembly is unit-testable without a live server.
/// Timestamps and numeric values are interpolated (values we control); user
/// string lists go through `sql_in_list`'s backslash-aware escaping; the `LIKE`
/// substring goes through `escape_str`.
pub(crate) fn http_exchanges_where_sql(query: &HttpExchangesQuery) -> String {
    let mut where_parts = vec![time_where(
        "request_time",
        query.time_range.start_us,
        query.time_range.end_us,
    )];
    if !query.server_ips.is_empty() {
        where_parts.push(format!("server_ip IN ({})", sql_in_list(&query.server_ips)));
    }
    if !query.client_ips.is_empty() {
        where_parts.push(format!("client_ip IN ({})", sql_in_list(&query.client_ips)));
    }
    if !query.methods.is_empty() {
        where_parts.push(format!("method IN ({})", sql_in_list(&query.methods)));
    }
    if !query.status_codes.is_empty() {
        where_parts.push(format!("status IN ({})", join_nums(&query.status_codes)));
    }
    if let Some(substr) = query
        .uri_contains
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        where_parts.push(format!("uri LIKE '%{}%'", escape_str(substr)));
    }
    if let Some(sse) = query.is_sse {
        where_parts.push(format!("is_sse = {}", if sse { 1 } else { 0 }));
    }
    where_parts.join(" AND ")
}

/// Map the `query_http_exchanges` virtual `sort_by` field to the ORDER BY
/// expression. `duration_ms` and `status` get `NULLS LAST` so incomplete
/// (duration/status=None) rows don't dominate a descending sort, matching the
/// DuckDB backend. Extracted as a pure fn for offline testability.
pub(crate) fn http_exchanges_order_expr(sort_by: &str) -> &'static str {
    match sort_by {
        "duration_ms" => {
            "(toUnixTimestamp64Micro(response_complete_time) \
             - toUnixTimestamp64Micro(request_time)) / 1000.0 NULLS LAST"
        }
        "status" => "status NULLS LAST",
        _ => "request_time",
    }
}

fn exchange_detail(r: ExchangeDetailRow) -> HttpExchangeDetail {
    HttpExchangeDetail {
        id: r.id,
        source_id: r.source_id,
        client_ip: r.client_ip,
        client_port: r.client_port,
        server_ip: r.server_ip,
        server_port: r.server_port,
        method: r.method,
        uri: r.uri,
        request_headers: r.request_headers,
        // Bodies are already `String` in ClickHouse (DuckDB stores BLOB and
        // renders to UTF-8 via `render_body_for_detail`); pass through.
        request_body: r.request_body,
        status: r.status,
        response_headers: r.response_headers,
        response_body: r.response_body,
        is_sse: r.is_sse,
        sse_event_count: r.sse_event_count,
        sse_data_bytes: r.sse_data_bytes,
        request_time: r.request_time_us,
        response_first_byte_time: r.response_first_byte_time_us,
        response_complete_time: r.response_complete_time_us,
    }
}

fn exchange_list_item(r: ExchangeListRow) -> HttpExchangeListItem {
    HttpExchangeListItem {
        id: r.id,
        source_id: r.source_id,
        request_time: r.request_time_ms,
        method: r.method,
        uri: r.uri,
        client_ip: r.client_ip,
        server_ip: r.server_ip,
        server_port: r.server_port,
        status: r.status,
        is_sse: r.is_sse,
        duration_ms: r.duration_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_nums_renders_numeric_in_list() {
        assert_eq!(join_nums(&[200u16, 429u16]), "200, 429");
        assert_eq!(join_nums(&[200u16]), "200");
        assert_eq!(join_nums::<u16>(&[]), "");
    }

    #[test]
    fn valid_sort_fields_is_whitelisted() {
        // sort_by is interpolated into ORDER BY, so the whitelist is the gate
        // that keeps an unknown field from reaching the engine.
        assert_eq!(VALID_SORT_FIELDS, &["request_time", "status", "duration_ms"]);
        assert!(!VALID_SORT_FIELDS.contains(&"bogus"));
    }

    fn detail_row() -> ExchangeDetailRow {
        ExchangeDetailRow {
            id: "xchg-1".into(),
            source_id: "src-0".into(),
            client_ip: "10.0.0.1".into(),
            client_port: 54321,
            server_ip: "10.0.0.2".into(),
            server_port: 8080,
            method: "POST".into(),
            uri: "/v1/chat/completions".into(),
            request_headers: r#"[["content-type","application/json"]]"#.into(),
            request_body: Some(r#"{"model":"gpt-4"}"#.into()),
            status: Some(200),
            response_headers: r#"[["x-request-id","abc"]]"#.into(),
            response_body: Some(r#"{"choices":[]}"#.into()),
            is_sse: false,
            sse_event_count: 0,
            sse_data_bytes: 0,
            request_time_us: 1_700_000_000_000_000,
            response_first_byte_time_us: Some(1_700_000_000_500_000),
            response_complete_time_us: Some(1_700_000_001_000_000),
        }
    }

    #[test]
    fn exchange_detail_maps_micros_timestamps_and_bodies() {
        let d = exchange_detail(detail_row());
        assert_eq!(d.id, "xchg-1");
        assert_eq!(d.source_id, "src-0");
        assert_eq!(d.client_ip, "10.0.0.1");
        assert_eq!(d.client_port, 54321);
        assert_eq!(d.server_ip, "10.0.0.2");
        assert_eq!(d.server_port, 8080);
        assert_eq!(d.method, "POST");
        assert_eq!(d.uri, "/v1/chat/completions");
        assert_eq!(d.request_headers, r#"[["content-type","application/json"]]"#);
        assert_eq!(d.request_body.as_deref(), Some(r#"{"model":"gpt-4"}"#));
        assert_eq!(d.status, Some(200));
        assert_eq!(d.response_headers, r#"[["x-request-id","abc"]]"#);
        assert_eq!(d.response_body.as_deref(), Some(r#"{"choices":[]}"#));
        assert!(!d.is_sse);
        assert_eq!(d.sse_event_count, 0);
        assert_eq!(d.sse_data_bytes, 0);
        // Microsecond timestamps pass through verbatim (DateTime64(6) ↔ i64 micros).
        assert_eq!(d.request_time, 1_700_000_000_000_000);
        assert_eq!(d.response_first_byte_time_us, Some(1_700_000_000_500_000));
        assert_eq!(d.response_complete_time_us, Some(1_700_000_001_000_000));
    }

    fn list_row() -> ExchangeListRow {
        ExchangeListRow {
            id: "xchg-1".into(),
            source_id: "src-0".into(),
            request_time_ms: 1_700_000_000_000,
            method: "POST".into(),
            uri: "/v1/chat/completions".into(),
            client_ip: "10.0.0.1".into(),
            server_ip: "10.0.0.2".into(),
            server_port: 8080,
            status: Some(200),
            is_sse: false,
            duration_ms: Some(1000.0),
        }
    }

    #[test]
    fn exchange_list_item_maps_ms_request_time_and_duration() {
        let it = exchange_list_item(list_row());
        assert_eq!(it.id, "xchg-1");
        assert_eq!(it.source_id, "src-0");
        assert_eq!(it.request_time, 1_700_000_000_000);
        assert_eq!(it.method, "POST");
        assert_eq!(it.uri, "/v1/chat/completions");
        assert_eq!(it.client_ip, "10.0.0.1");
        assert_eq!(it.server_ip, "10.0.0.2");
        assert_eq!(it.server_port, 8080);
        assert_eq!(it.status, Some(200));
        assert!(!it.is_sse);
        assert_eq!(it.duration_ms, Some(1000.0));
    }

    #[test]
    fn exchange_list_item_passes_none_status_and_duration() {
        let mut r = list_row();
        r.status = None;
        r.duration_ms = None;
        let it = exchange_list_item(r);
        assert_eq!(it.status, None);
        assert_eq!(it.duration_ms, None);
    }

    fn exchanges_query() -> HttpExchangesQuery {
        HttpExchangesQuery {
            time_range: TimeRange { start_us: 100, end_us: 200 },
            server_ips: vec![],
            client_ips: vec![],
            methods: vec![],
            status_codes: vec![],
            uri_contains: None,
            is_sse: None,
            sort_by: "request_time".into(),
            sort_order: "desc".into(),
            page: 1,
            page_size: 10,
        }
    }

    #[test]
    fn http_exchanges_where_sql_is_time_range_only_by_default() {
        let s = http_exchanges_where_sql(&exchanges_query());
        assert_eq!(
            s,
            "request_time >= fromUnixTimestamp64Micro(100) \
             AND request_time < fromUnixTimestamp64Micro(200)"
        );
    }

    #[test]
    fn http_exchanges_where_sql_combines_all_filters() {
        let q = HttpExchangesQuery {
            server_ips: vec!["10.0.0.2".into()],
            client_ips: vec!["10.0.0.1".into()],
            methods: vec!["POST".into()],
            status_codes: vec![200, 429],
            uri_contains: Some("/v1/chat".into()),
            is_sse: Some(true),
            ..exchanges_query()
        };
        let s = http_exchanges_where_sql(&q);
        assert!(s.contains("server_ip IN ('10.0.0.2')"));
        assert!(s.contains("client_ip IN ('10.0.0.1')"));
        assert!(s.contains("method IN ('POST')"));
        assert!(s.contains("status IN (200, 429)"));
        assert!(s.contains("uri LIKE '%/v1/chat%'"));
        assert!(s.contains("is_sse = 1"));
        assert!(!s.starts_with(" AND"));
        assert!(!s.ends_with("AND "));
    }

    #[test]
    fn http_exchanges_where_sql_escapes_like_quote() {
        let q = HttpExchangesQuery {
            uri_contains: Some("a'b".into()),
            ..exchanges_query()
        };
        assert!(http_exchanges_where_sql(&q).contains("uri LIKE '%a''b%'"));
    }

    #[test]
    fn http_exchanges_where_sql_ignores_blank_like() {
        let q = HttpExchangesQuery {
            uri_contains: Some("  ".into()),
            ..exchanges_query()
        };
        assert!(!http_exchanges_where_sql(&q).contains("LIKE"));
    }

    #[test]
    fn http_exchanges_where_sql_is_sse_false() {
        let q = HttpExchangesQuery {
            is_sse: Some(false),
            ..exchanges_query()
        };
        assert!(http_exchanges_where_sql(&q).contains("is_sse = 0"));
    }

    #[test]
    fn http_exchanges_order_expr_maps_virtual_fields() {
        assert_eq!(http_exchanges_order_expr("request_time"), "request_time");
        assert_eq!(http_exchanges_order_expr("status"), "status NULLS LAST");
        // duration_ms derives from the complete−request gap with NULLS LAST so
        // incomplete exchanges don't dominate a descending sort.
        let d = http_exchanges_order_expr("duration_ms");
        assert!(d.contains("toUnixTimestamp64Micro(response_complete_time)"));
        assert!(d.contains("toUnixTimestamp64Micro(request_time)"));
        assert!(d.contains("NULLS LAST"));
        // An unknown sort_by falls back to request_time (the whitelist rejects
        // it before this is reached, but the fallback must be safe regardless).
        assert_eq!(http_exchanges_order_expr("bogus"), "request_time");
    }
}
