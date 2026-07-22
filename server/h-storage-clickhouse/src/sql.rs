//! Shared SQL fragment builders for ClickHouse reads. The dimension-filter
//! `'*'` wildcard logic lives in the backend-neutral `h_storage::dialect`;
//! these helpers cover ClickHouse-specific concerns (DateTime64 time ranges,
//! literal escaping).

/// Escape a string for embedding inside a single-quoted ClickHouse literal.
///
/// ClickHouse processes C-style backslash escapes inside `'...'` (it treats
/// `\'` as an escaped quote in addition to the SQL-standard `''`), so quoting
/// must escape backslashes as well as quotes — otherwise a value ending in `\`
/// consumes the closing quote and breaks out of the literal (SQL injection).
/// Delegates to the backend-neutral `escape_clickhouse` so the rule lives in
/// one place. Used for id / turn_id literals and `LIKE` substrings; `%` / `_`
/// are intentionally NOT escaped so `LIKE '%x%'` keeps substring semantics.
pub(crate) fn escape_str(s: &str) -> String {
    h_storage::dialect::escape_clickhouse(s)
}

/// ClickHouse IN-list builder. Mirrors `h_storage::dialect::sql_in_list` but
/// uses ClickHouse's backslash-aware escaping. ClickHouse call sites MUST use
/// this instead of the backend-neutral `sql_in_list`, whose quote-only
/// escaping is correct for DuckDB/Postgres but injectable on ClickHouse.
pub(crate) fn sql_in_list(values: &[String]) -> String {
    h_storage::dialect::sql_in_list_with(values, h_storage::dialect::escape_clickhouse)
}

/// Half-open time-range predicate on a `DateTime64(6)` column, comparing against
/// microsecond bounds via `fromUnixTimestamp64Micro` so the MergeTree
/// primary-key index on the timestamp column stays usable. `start_us`/`end_us`
/// are values we control, so interpolation is injection-safe.
pub(crate) fn time_where(col: &str, start_us: i64, end_us: i64) -> String {
    format!(
        "{col} >= fromUnixTimestamp64Micro({start_us}) \
         AND {col} < fromUnixTimestamp64Micro({end_us})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_str_doubles_backslash_before_quote() {
        // The ClickHouse SQL-injection payload: a trailing backslash consumes the
        // closing quote (ClickHouse treats `\'` as an escaped quote). Backslash
        // must be doubled *before* the quote is doubled so the literal stays closed.
        assert_eq!(escape_str(r"\') OR 1=1 --"), r"\\'') OR 1=1 --");
    }

    #[test]
    fn escape_str_doubles_single_quotes() {
        assert_eq!(escape_str("o'brien"), "o''brien");
        assert_eq!(escape_str("a''b"), "a''''b");
    }

    #[test]
    fn escape_str_leaves_like_wildcards() {
        // `%` / `_` are intentionally NOT escaped so `LIKE '%x%'` keeps substring
        // semantics — the call sites wrap the value in `%...%` themselves.
        assert_eq!(escape_str("a%b_c"), "a%b_c");
    }

    #[test]
    fn escape_str_round_trips_clean_values() {
        assert_eq!(escape_str("call-1"), "call-1");
        assert_eq!(escape_str("server\\path"), "server\\\\path");
        assert_eq!(escape_str(""), "");
    }

    #[test]
    fn sql_in_list_quotes_and_comma_joins() {
        assert_eq!(sql_in_list(&["a".into(), "b".into()]), "'a', 'b'");
        assert_eq!(sql_in_list(&["only".into()]), "'only'");
        // Empty input yields an empty IN-list body (call sites guard emptiness
        // before emitting `IN (...)`, so this is a pure-rendering property).
        assert_eq!(sql_in_list(&[]), "");
    }

    #[test]
    fn sql_in_list_uses_backslash_aware_escaping() {
        // A value containing both a backslash and a quote must stay a single
        // closed literal — the ClickHouse-aware escaping differs from the
        // backend-neutral (quote-only) `sql_in_list`.
        let vals = vec![r"\')".to_string()];
        // ClickHouse: backslash doubled first, then quote doubled → '\\''  wrapped in quotes.
        assert_eq!(sql_in_list(&vals), r"'\\'')'");
        // Backend-neutral (DuckDB/Postgres) would NOT double the backslash —
        // only the quote is doubled, so the trailing backslash stays lone and
        // would (wrongly, for ClickHouse) consume the closing quote.
        assert_eq!(h_storage::dialect::sql_in_list(&vals), r"'\'')'");
        assert_ne!(sql_in_list(&vals), h_storage::dialect::sql_in_list(&vals));
    }

    #[test]
    fn time_where_is_half_open_with_micro_bounds() {
        let s = time_where("request_time", 100, 200);
        assert_eq!(
            s,
            "request_time >= fromUnixTimestamp64Micro(100) \
             AND request_time < fromUnixTimestamp64Micro(200)"
        );
    }

    #[test]
    fn time_where_interpolates_column_verbatim() {
        // The column name is caller-controlled (a constant in every call site);
        // it is interpolated verbatim, not escaped — so the literal column name
        // appears exactly.
        let s = time_where("start_time", -5, 0);
        assert!(s.starts_with("start_time >= fromUnixTimestamp64Micro(-5)"));
        assert!(s.contains("start_time < fromUnixTimestamp64Micro(0)"));
    }

    #[test]
    fn time_where_equal_bounds_is_empty_range() {
        // Half-open `>= x AND < x` matches nothing — the read-path relies on
        // this to express point-adjacency exclusion.
        let s = time_where("timestamp", 7, 7);
        assert_eq!(
            s,
            "timestamp >= fromUnixTimestamp64Micro(7) \
             AND timestamp < fromUnixTimestamp64Micro(7)"
        );
    }
}
