//! `llm_metrics` / `llm_finish_metrics` — write path.
//!
//! Metrics are the one entity where a duplicate row is not merely untidy: the
//! read path SUMs across rows, so a resend that lands twice inflates a chart
//! instead of showing a repeat. Three things guard that:
//!
//! 1. Metrics go out in their own small POST, well away from the multi-megabyte
//!    body batches, so they hit the failure paths that cause resends far less
//!    often in the first place.
//! 2. Each row carries a `row_id` minted **here**, before any retry, so the
//!    same logical row keeps the same id no matter how many times it is sent.
//!    That makes a duplicate detectable rather than invisible.
//! 3. `storage.sglake.metrics_dedup` turns on read-side deduplication for
//!    deployments that actually observe duplicates. It is off by default
//!    because `dedup` requires a full sort, and that is not a price to pay
//!    continuously against an event that may never happen.
//!
//! Granularity is part of the index name, not a field: sglake's retention is
//! per-index and Heron's metrics retention is per-granularity, so the two line
//! up exactly, and the most common filter becomes index-level pruning.

use h_common::error::Result;
use h_metrics::model::{LlmFinishMetric, LlmMetric};

use crate::rows::{finish_event, metric_event, Envelope, ST_FINISH, ST_METRIC};
use crate::SglakeBackend;

impl SglakeBackend {
    pub(crate) async fn write_metrics(&self, metrics: Vec<LlmMetric>) -> Result<()> {
        if metrics.is_empty() {
            return Ok(());
        }
        let mut events = Vec::with_capacity(metrics.len());
        let mut unknown_granularity = 0usize;
        for m in &metrics {
            let Some(index) = self.ix.metrics_for(m.granularity) else {
                unknown_granularity += 1;
                continue;
            };
            let e = metric_event(m, uuid::Uuid::now_v7().to_string());
            match Envelope::new(m.timestamp_us, &m.source_id, ST_METRIC, index, e).encode() {
                Ok(s) => events.push(s),
                Err(err) => tracing::error!(
                    target: "sglake::write", error = %err,
                    "sglake: failed to encode metric event; skipping it"
                ),
            }
        }
        warn_unknown_granularity(unknown_granularity, "llm_metrics");
        self.hec.send(events).await
    }

    pub(crate) async fn write_finish_metrics(&self, metrics: Vec<LlmFinishMetric>) -> Result<()> {
        if metrics.is_empty() {
            return Ok(());
        }
        let mut events = Vec::with_capacity(metrics.len());
        let mut unknown_granularity = 0usize;
        for m in &metrics {
            let Some(index) = self.ix.finish_for(&m.granularity) else {
                unknown_granularity += 1;
                continue;
            };
            let e = finish_event(m, uuid::Uuid::now_v7().to_string());
            match Envelope::new(m.timestamp_us, &m.source_id, ST_FINISH, index, e).encode() {
                Ok(s) => events.push(s),
                Err(err) => tracing::error!(
                    target: "sglake::write", error = %err,
                    "sglake: failed to encode finish-metric event; skipping it"
                ),
            }
        }
        warn_unknown_granularity(unknown_granularity, "llm_finish_metrics");
        self.hec.send(events).await
    }
}

/// A granularity with no index is a configuration mismatch, not a data
/// problem: the aggregator emitted a cadence this backend was never told
/// about. Dropping it silently would leave a hole in a chart with nothing to
/// explain it.
fn warn_unknown_granularity(count: usize, entity: &'static str) {
    if count > 0 {
        tracing::error!(
            target: "sglake::write",
            entity,
            dropped = count,
            "sglake: dropped metric row(s) whose granularity has no index. \
             The aggregator is emitting a cadence this backend does not know."
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rows::fixtures;
    use crate::schema::Indexes;

    /// Every granularity the aggregator can emit must resolve to a distinct
    /// index; an unknown one must resolve to nothing rather than to a
    /// neighbour's index, which would blend two cadences into one series.
    #[test]
    fn granularity_routes_to_its_own_index() {
        let ix = Indexes::new("heron");
        assert_eq!(ix.metrics_for("10s"), Some("heron_metrics_10s"));
        assert_eq!(ix.metrics_for("1h"), Some("heron_metrics_1h"));
        assert_eq!(ix.finish_for("10s"), Some("heron_finish_10s"));
        assert_eq!(ix.metrics_for("nope"), None);
    }

    /// `row_id` is what makes a duplicated write detectable, so it has to be
    /// present and unique per row.
    #[test]
    fn each_metric_row_carries_a_distinct_row_id() {
        let m = fixtures::sample_metric();
        let a = metric_event(&m, uuid::Uuid::now_v7().to_string());
        let b = metric_event(&m, uuid::Uuid::now_v7().to_string());
        assert!(!a.row_id.is_empty());
        assert_ne!(a.row_id, b.row_id);
    }
}
