//! Shared read primitives: fetch whole events, decode them in Rust.
//!
//! Two rules hold for every read in this backend.
//!
//! **Decode from `_raw`, never from the extracted fields.** Search output is
//! lossy in three ways that each corrupt a struct without erroring: null
//! fields are dropped, a single-element multivalue collapses to a scalar, and
//! integers past 2^53 come back as strings. Extracted fields are for filtering
//! and aggregating; `_raw` is for reconstructing.
//!
//! **Always bound the time window.** An unbounded search consults every bucket
//! in the retention window, which is the one cost that grows without limit as
//! a deployment ages. Point lookups get their bounds from the UUIDv7 id
//! itself, with an unbounded retry as the safety net — see [`crate::spl::id_window`]
//! for why the hint can legitimately miss.

use serde::de::DeserializeOwned;

use h_common::error::Result;

use crate::spl::{self, raw_query};
use crate::SglakeBackend;

impl SglakeBackend {
    /// Run a `| table _raw` query and decode each row into `T`.
    ///
    /// A row that fails to decode is skipped and logged rather than failing
    /// the whole query: one malformed event should cost one row in a trace
    /// view, not the entire view.
    pub(crate) async fn fetch_raw<T: DeserializeOwned>(
        &self,
        what: &'static str,
        search: &str,
        limit: usize,
        earliest: &str,
        latest: &str,
    ) -> Result<Vec<T>> {
        let result = self
            .search
            .search(&raw_query(search, limit), earliest, latest)
            .await?;
        let mut out = Vec::new();
        let mut undecodable = 0usize;
        for row in result.rows() {
            match row.get("_raw").and_then(|v| v.as_str()) {
                Some(raw) => match serde_json::from_str::<T>(raw) {
                    Ok(v) => out.push(v),
                    Err(_) => undecodable += 1,
                },
                None => undecodable += 1,
            }
        }
        if undecodable > 0 {
            tracing::warn!(
                target: "sglake::read",
                query = what,
                skipped = undecodable,
                "sglake: skipped event(s) that could not be decoded"
            );
        }
        Ok(out)
    }

    /// A point lookup bounded by the id's own UUIDv7 timestamp, retried
    /// unbounded if that window turns up nothing.
    ///
    /// The retry is not belt-and-braces: replaying a captured pcap stamps
    /// events with capture-time `_time` while their ids are minted now, so the
    /// derived window is guaranteed to miss. Costing one extra empty query on
    /// a genuine miss buys a bounded lookup on every hit.
    pub(crate) async fn fetch_raw_by_id<T: DeserializeOwned>(
        &self,
        what: &'static str,
        search: &str,
        limit: usize,
        id: &str,
    ) -> Result<Vec<T>> {
        if let Some((earliest, latest)) = spl::id_window(id) {
            let hit: Vec<T> = self
                .fetch_raw(what, search, limit, &earliest, &latest)
                .await?;
            if !hit.is_empty() {
                return Ok(hit);
            }
        }
        self.fetch_raw(what, search, limit, "0", "0").await
    }

    /// Widen a `[start, end]` microsecond range by the configured trace skew
    /// and render it as search bounds.
    pub(crate) fn window(&self, start_us: i64, end_us: i64) -> (String, String) {
        (
            spl::epoch_secs(start_us.saturating_sub(self.trace_time_skew_us)),
            spl::epoch_secs(end_us.saturating_add(self.trace_time_skew_us)),
        )
    }
}

#[cfg(test)]
mod tests {
    use crate::spl::id_window;

    /// A UUIDv7 carries its own millisecond timestamp, which is what makes a
    /// by-id lookup prunable at all.
    #[test]
    fn id_window_brackets_a_uuidv7_timestamp() {
        let id = uuid::Uuid::now_v7().to_string();
        let (earliest, latest) = id_window(&id).expect("v7 id must yield a window");
        let e: f64 = earliest.parse().unwrap();
        let l: f64 = latest.parse().unwrap();
        assert!(e < l);
        // The window must actually contain "now".
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();
        assert!(e <= now && now <= l, "window {e}..{l} excludes {now}");
    }

    /// Ids Heron did not mint — a provider-supplied `turn_id`, a v4 UUID —
    /// must yield no window at all rather than a wrong one.
    #[test]
    fn id_window_declines_non_v7_ids() {
        assert!(id_window("turn_abc123").is_none());
        assert!(id_window("").is_none());
        assert!(id_window(&uuid::Uuid::new_v4().to_string()).is_none());
        assert!(id_window("not-a-uuid-at-all-really").is_none());
    }
}
