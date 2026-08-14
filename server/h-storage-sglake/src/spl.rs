//! SPL construction helpers: quoting, IN-lists, time windows, pagination.
//!
//! Two hazards drive everything in this module.
//!
//! **Injection.** Every value that reaches a query is attacker-influenced in
//! principle (model names and request paths come off the wire). SPL's
//! double-quoted string understands exactly two escapes, `\"` and `\\`, and
//! keeps unknown ones verbatim (`sglog-spl/src/cursor.rs:130`), so [`quote`]
//! escapes those two and nothing else.
//!
//! **`*` is a wildcard with no escape.** `search field="*"` matches *every*
//! non-empty value rather than a literal asterisk, and there is no way to
//! escape it in a search term — `plan.rs:619` routes any value containing `*`
//! to `wildcard_match`, which has no `\*` branch. A value that happens to
//! contain `*` therefore silently becomes a pattern. [`match_term`] detects
//! this and falls back to `| where field == "..."`, which compares literally
//! (`sglog-eval/src/compile.rs` `BinOp::Eq`). That costs index pushdown, so it
//! only kicks in for the values that actually need it.

/// Quote a value as an SPL double-quoted string literal.
pub(crate) fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// True when a value cannot be used in a `search` term without being
/// reinterpreted as a glob.
pub(crate) fn needs_literal_compare(v: &str) -> bool {
    v.contains('*')
}

/// A single equality predicate for the `search` command, or `None` when the
/// value must be compared literally in a later `| where` stage instead.
pub(crate) fn match_term(field: &str, value: &str) -> Option<String> {
    if needs_literal_compare(value) {
        None
    } else {
        Some(format!("{field}={}", quote(value)))
    }
}

/// `field IN ("a", "b")` — equivalent to an OR chain but parsed as one node.
/// Returns `None` for an empty list (the caller must decide whether that means
/// "no filter" or "match nothing"; those are different and must not be
/// conflated).
pub(crate) fn in_list(field: &str, values: &[String]) -> Option<String> {
    if values.is_empty() {
        return None;
    }
    let items: Vec<String> = values.iter().map(|v| quote(v)).collect();
    Some(format!("{field} IN ({})", items.join(", ")))
}

/// A literal `==` comparison for the `| where` stage. Use when the value may
/// contain `*`, or when comparing against sglake's own rollup sentinels.
#[allow(dead_code)] // used from Phase 2 onward (list filters)
pub(crate) fn where_eq(field: &str, value: &str) -> String {
    format!("{field} == {}", quote(value))
}

/// Convert Heron's microsecond timestamp to the epoch-seconds string the
/// search API takes for `earliest` / `latest`.
///
/// These bound bucket pruning, which is the single most effective thing a
/// query can do here, so they should always be set. `"0"` means unbounded and
/// forces a full scan.
pub(crate) fn epoch_secs(us: i64) -> String {
    format!(
        "{}.{:06}",
        us.div_euclid(1_000_000),
        us.rem_euclid(1_000_000)
    )
}

/// Chunk size for `id IN (...)` point lookups. Keeps a single query string
/// bounded while staying far above the common trace size.
pub(crate) const ID_CHUNK: usize = 512;

/// Build the offset-pagination pipeline.
///
/// `sort <offset+limit>` immediately after `search` keeps the executor on its
/// bounded top-k path (O(2N) memory) instead of materializing the window;
/// `| tail <limit>` then takes exactly the requested page; and the trailing
/// `| table` switches the response into "results" mode, which is **not**
/// subject to `max_events`. The sort limit is always written explicitly —
/// a bare `| sort f` means `sort 10000 f` in current sglog
/// (`sglog-spl/src/commands.rs`), and older builds do not apply that cap at
/// all, so relying on either behaviour would be version-dependent.
///
/// `sort_keys` must already include a deterministic tie-break (`ts_us` then
/// `id`): equal `_time` values order by storage order, which changes when hot
/// buckets are sealed or merged, and unstable ordering makes pagination drop
/// or repeat rows.
#[allow(dead_code)] // used from Phase 2 onward (list pagination)
pub(crate) fn paginate(
    search: &str,
    sort_keys: &str,
    offset: u64,
    limit: u64,
    columns: &[&str],
) -> String {
    format!(
        "{search} | sort {} {sort_keys} | tail {limit} | table {}",
        offset + limit,
        columns.join(", ")
    )
}

/// The companion count query. A pipeline's `total` is the number of rows it
/// *emitted*, not the number matched, so the page size and the total have to
/// come from two different queries.
#[allow(dead_code)] // used from Phase 2 onward (page totals)
pub(crate) fn count_query(search: &str) -> String {
    format!("{search} | stats count as n | table n")
}

/// Fetch whole events rather than columns.
///
/// Reads always go through `_raw` and are deserialized in Rust, never assembled
/// from the extracted fields beside it. Search output is lossy in three ways
/// that all corrupt a struct silently: a null field is dropped rather than
/// returned as null, a single-element multivalue collapses into a bare scalar,
/// and an integer past 2^53 comes back as a string. `_raw` has none of those
/// problems — it is the event as written.
pub(crate) fn raw_query(search: &str, limit: usize) -> String {
    format!("{search} | head {limit} | table _raw")
}

/// Widen a point lookup's time window by this much on each side, in
/// microseconds. Covers clock skew between the capture host and the id
/// minting, plus a turn that is still open when its id is generated.
const ID_WINDOW_SKEW_US: i64 = 6 * 3_600_000_000;

/// Best-effort `(earliest, latest)` derived from a UUIDv7's embedded
/// millisecond timestamp.
///
/// Every id Heron mints is a UUIDv7, so a by-id lookup can usually prune to a
/// handful of buckets instead of consulting every bucket in the retention
/// window. Two cases make this a hint rather than a fact, and both are why
/// callers must fall back to an unbounded retry when the window comes up
/// empty:
///
/// * `turn_id` can come from the provider (Codex sends its own), in which case
///   it is not a UUIDv7 at all and this returns `None`.
/// * The id is minted when the pipeline sees the record, but `_time` comes
///   from the packet. Replaying a captured pcap makes those years apart, so
///   the derived window would exclude the very event it is looking for —
///   which is exactly how the test corpus and the staging soak run.
pub(crate) fn id_window(id: &str) -> Option<(String, String)> {
    let uuid = uuid::Uuid::parse_str(id).ok()?;
    let ts = uuid.get_timestamp()?;
    let (secs, nanos) = ts.to_unix();
    let us = i64::try_from(secs).ok()?.checked_mul(1_000_000)? + (nanos / 1000) as i64;
    Some((
        epoch_secs(us.saturating_sub(ID_WINDOW_SKEW_US)),
        epoch_secs(us.saturating_add(ID_WINDOW_SKEW_US)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_escapes_quote_and_backslash_only() {
        assert_eq!(quote("plain"), r#""plain""#);
        assert_eq!(quote(r#"a"b"#), r#""a\"b""#);
        assert_eq!(quote(r"a\b"), r#""a\\b""#);
        // Unknown escapes stay verbatim on the parser side, so we must not
        // touch them here either.
        assert_eq!(quote(r"\d+"), r#""\\d+""#);
        assert_eq!(quote("中文 模型"), r#""中文 模型""#);
    }

    /// The breakout attempt: close the string, then append another clause.
    /// After quoting, the payload must remain a single string literal.
    #[test]
    fn quote_neutralizes_breakout() {
        let payload = r#"x" OR index=* | delete "#;
        let q = quote(payload);
        assert!(q.starts_with('"') && q.ends_with('"'));
        // The only unescaped quotes are the delimiters.
        let inner = &q[1..q.len() - 1];
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                chars.next(); // consume the escaped char
            } else {
                assert_ne!(c, '"', "unescaped quote leaked into {q}");
            }
        }
    }

    /// A trailing backslash must not escape the closing delimiter.
    #[test]
    fn quote_handles_trailing_backslash() {
        assert_eq!(quote(r"end\"), r#""end\\""#);
    }

    #[test]
    fn match_term_defers_wildcard_values_to_where() {
        assert_eq!(match_term("model", "gpt-4").unwrap(), r#"model="gpt-4""#);
        // `*` would silently become a glob in a search term.
        assert!(match_term("wire_api", "*").is_none());
        assert!(match_term("model", "gpt*").is_none());
        assert_eq!(where_eq("wire_api", "*"), r#"wire_api == "*""#);
    }

    #[test]
    fn in_list_quotes_each_value() {
        assert_eq!(in_list("id", &[]), None);
        assert_eq!(
            in_list("id", &["a".into(), r#"b"c"#.into()]).unwrap(),
            r#"id IN ("a", "b\"c")"#
        );
    }

    #[test]
    fn epoch_secs_keeps_microsecond_precision() {
        assert_eq!(epoch_secs(1_785_638_114_914_200), "1785638114.914200");
        assert_eq!(epoch_secs(1_000_000), "1.000000");
        assert_eq!(epoch_secs(0), "0.000000");
        // Negative timestamps must not produce a malformed literal.
        assert_eq!(epoch_secs(-1), "-1.999999");
    }

    #[test]
    fn paginate_writes_explicit_sort_limit_and_table() {
        let q = paginate(
            "search index=x",
            "-num(ts_us), -str(id)",
            100,
            50,
            &["id", "ts_us"],
        );
        assert!(q.contains("| sort 150 -num(ts_us), -str(id)"), "{q}");
        assert!(q.contains("| tail 50"), "{q}");
        assert!(q.ends_with("| table id, ts_us"), "{q}");
    }
}
