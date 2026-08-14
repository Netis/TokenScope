//! HTTP clients: [`HecClient`] for writes, [`SearchClient`] for reads,
//! [`ManagementClient`] for per-index retention.
//!
//! Each wraps one `reqwest::Client` (internally an `Arc`'d connection pool).
//! We deliberately do not reuse sglog's own `sglog-agent` HEC client: it opens
//! a fresh TCP connection per request, cannot do TLS or gzip, and discards the
//! response body — but the response body is exactly what the retry state
//! machine needs, since a partial-success 400 carries the index of the first
//! bad event.

use std::collections::HashMap;
use std::time::Duration;

use h_common::config::SglakeConfig;
use h_common::error::{AppError, Result};
use serde::Deserialize;

fn err<E: std::fmt::Display>(ctx: &str, e: E) -> AppError {
    AppError::Storage(format!("sglake {ctx}: {e}"))
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// Splunk HEC writer.
///
/// # Retry semantics — at-least-once
///
/// [`h_storage::WriteBuffer`] discards a batch whose flush returns `Err`, so
/// all retrying has to happen here. The rules follow what sglogd actually
/// does:
///
/// * **200** — events are already fsynced. Never resend.
/// * **400 with `invalid-event-number: k`** — HEC ingests the valid prefix and
///   stops at the first bad event, so `[start, start+k)` is committed, event
///   `k` is malformed, and the rest was never seen. Skip past `k` and carry
///   on; this is deterministic progress, not a retry, so it does not consume
///   the retry budget.
/// * **401 / 415 / other 400** — configuration or protocol faults. Resending
///   cannot help.
/// * **413** — halve the batch and re-split once.
/// * **5xx / timeout / connection error** — the request may or may not have
///   landed. With acks enabled, ask before resending; otherwise resend and
///   accept a possible duplicate.
///
/// The gap this leaves is a sglogd restart mid-flight: ack ids are
/// process-local and reset, so a resend can duplicate. Duplicates are visible
/// (two rows with one id) and harmless for everything except metric sums,
/// which is what `metrics_dedup` is for.
///
/// # How the ack is actually used
///
/// sglake issues an ack id **in the same response that reports success** — so
/// there is no id to ask about when the response is the thing that got lost.
/// The way through is to send every request on a **freshly minted channel**:
/// sglake's per-channel counter starts at zero, so the only id that request
/// could ever be given is `0`, and `POST /services/collector/ack` with
/// `{"acks":[0]}` becomes a direct question — *did this request commit?*
/// Measured against sglogd: `false` before the write, `true` after.
///
/// The answer degrades safely in every direction. sglake's channel table is
/// in-memory and LRU-capped, so a restart or heavy churn answers `false` and
/// we resend — exactly what would have happened with acks off. A 400 never
/// issues an ack id, but that path is already deterministic through
/// `invalid-event-number`, so it never consults one. The case acks cannot
/// cover is a 500 raised after some indexes in the batch already committed:
/// no id is issued, and the resend duplicates that prefix.
pub(crate) struct HecClient {
    http: reqwest::Client,
    endpoint: String,
    ack_endpoint: String,
    token: String,
    max_body_bytes: usize,
    max_event_bytes: usize,
    gzip: bool,
    use_ack: bool,
    retries: u32,
    backoff: Duration,
}

/// What sglogd said about one HEC request.
enum HecOutcome {
    Ok,
    /// Valid prefix committed; event at this 0-based index is malformed.
    PartialUpTo(usize),
    TooLarge,
    /// Worth another attempt (5xx, timeout, connection reset).
    Transient(String),
    /// Retrying cannot help.
    Permanent(String),
}

#[derive(Deserialize)]
struct HecResponse {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    text: String,
    #[serde(rename = "invalid-event-number", default)]
    invalid_event_number: Option<usize>,
}

/// `{"acks": {"0": true}}` — the answer to an ack query.
#[derive(Deserialize, Default)]
struct AckResponse {
    #[serde(default)]
    acks: HashMap<String, bool>,
}

impl HecClient {
    pub(crate) fn new(config: &SglakeConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.request_timeout_secs))
            .build()
            .map_err(|e| err("client build", e))?;
        let base = config.url.trim_end_matches('/');
        Ok(Self {
            http,
            endpoint: format!("{base}/services/collector/event"),
            ack_endpoint: format!("{base}/services/collector/ack"),
            token: config.hec_token.clone(),
            max_body_bytes: config.max_body_bytes,
            max_event_bytes: config.max_event_bytes,
            gzip: config.gzip,
            use_ack: config.use_ack,
            retries: config.write_retries,
            backoff: Duration::from_millis(config.retry_backoff_ms),
        })
    }

    /// Send pre-serialized HEC envelopes (one JSON object per element, no
    /// trailing newline needed — sglogd parses a concatenated stream).
    pub(crate) async fn send(&self, events: Vec<String>) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let events = self.enforce_event_size(events);
        for chunk in self.split_by_bytes(&events) {
            self.send_chunk(chunk).await?;
        }
        Ok(())
    }

    /// Drop any single event that exceeds the configured ceiling.
    ///
    /// An event past sglake's 16 MiB WAL frame limit is treated as corruption
    /// during crash replay and silently discarded — the worst possible failure
    /// mode. Refusing to send it trades one lost event for a loud log line and
    /// a store that stays replayable. `[body_cap]` normally keeps events three
    /// orders of magnitude below this; the guard matters when it is disabled.
    fn enforce_event_size(&self, events: Vec<String>) -> Vec<String> {
        let mut oversized = 0usize;
        let kept: Vec<String> = events
            .into_iter()
            .filter(|e| {
                if e.len() > self.max_event_bytes {
                    oversized += 1;
                    false
                } else {
                    true
                }
            })
            .collect();
        if oversized > 0 {
            tracing::error!(
                target: "sglake::write",
                dropped = oversized,
                max_event_bytes = self.max_event_bytes,
                "sglake: dropped oversized event(s); they would be discarded as \
                 corruption on crash replay. Enable [body_cap] or lower it."
            );
        }
        kept
    }

    fn split_by_bytes<'a>(&self, events: &'a [String]) -> Vec<&'a [String]> {
        let mut out = Vec::new();
        let (mut start, mut acc) = (0usize, 0usize);
        for (i, e) in events.iter().enumerate() {
            let n = e.len() + 1;
            if acc + n > self.max_body_bytes && i > start {
                out.push(&events[start..i]);
                start = i;
                acc = 0;
            }
            acc += n;
        }
        if start < events.len() {
            out.push(&events[start..]);
        }
        out
    }

    async fn send_chunk(&self, chunk: &[String]) -> Result<()> {
        let mut start = 0usize;
        let mut attempt = 0u32;
        while start < chunk.len() {
            match self.post(&chunk[start..]).await {
                HecOutcome::Ok => return Ok(()),
                HecOutcome::PartialUpTo(k) => {
                    tracing::warn!(
                        target: "sglake::write",
                        index = start + k,
                        "sglake rejected an event; the batch prefix before it is \
                         committed. Skipping it and continuing."
                    );
                    start += k + 1;
                }
                HecOutcome::TooLarge => {
                    // Re-split this range with a smaller ceiling. One level is
                    // enough: max_body_bytes is already well under sglogd's
                    // default and events are individually capped.
                    let half = (chunk.len() - start).div_ceil(2).max(1);
                    if half == chunk.len() - start {
                        return Err(err("write", "413 on an unsplittable batch"));
                    }
                    let mid = start + half;
                    Box::pin(self.send_chunk(&chunk[start..mid])).await?;
                    Box::pin(self.send_chunk(&chunk[mid..])).await?;
                    return Ok(());
                }
                HecOutcome::Transient(msg) => {
                    attempt += 1;
                    if attempt > self.retries {
                        return Err(err("write", format!("giving up after {attempt}: {msg}")));
                    }
                    tokio::time::sleep(self.backoff * attempt).await;
                }
                HecOutcome::Permanent(msg) => return Err(err("write", msg)),
            }
        }
        Ok(())
    }

    async fn post(&self, events: &[String]) -> HecOutcome {
        let mut body = Vec::with_capacity(events.iter().map(|e| e.len() + 1).sum());
        for e in events {
            body.extend_from_slice(e.as_bytes());
            body.push(b'\n');
        }

        // A channel used exactly once, so the only ack id it can be given is
        // 0 and asking about that id asks about this request. See the type
        // docs for why a shared channel could not answer the same question.
        let channel = self
            .use_ack
            .then(|| uuid::Uuid::now_v7().to_string())
            .filter(|_| !events.is_empty());

        let mut req = self.http.post(&self.endpoint);
        if !self.token.is_empty() {
            req = req.header("Authorization", format!("Splunk {}", self.token));
        }
        if let Some(ch) = &channel {
            req = req.header("X-Splunk-Request-Channel", ch);
        }
        if self.gzip {
            use flate2::{write::GzEncoder, Compression};
            use std::io::Write;
            let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
            if enc.write_all(&body).is_ok() {
                if let Ok(z) = enc.finish() {
                    body = z;
                    req = req.header("Content-Encoding", "gzip");
                }
            }
        }

        let resp = match req.body(body).send().await {
            Ok(r) => r,
            Err(e) => {
                return self
                    .resolve_transient(channel.as_deref(), e.to_string())
                    .await
            }
        };
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if status.is_success() {
            return HecOutcome::Ok;
        }
        if status.as_u16() == 413 {
            return HecOutcome::TooLarge;
        }
        if status.is_server_error() {
            return self
                .resolve_transient(channel.as_deref(), format!("{status}: {}", truncate(&text)))
                .await;
        }
        if status.as_u16() == 400 {
            if let Ok(r) = serde_json::from_str::<HecResponse>(&text) {
                if let Some(k) = r.invalid_event_number {
                    return HecOutcome::PartialUpTo(k);
                }
                return HecOutcome::Permanent(format!("400 code={} {}", r.code, truncate(&r.text)));
            }
        }
        HecOutcome::Permanent(format!("{status}: {}", truncate(&text)))
    }

    /// The request failed in a way that leaves it genuinely unknown whether
    /// the batch landed. With acks on, stop guessing and ask.
    async fn resolve_transient(&self, channel: Option<&str>, msg: String) -> HecOutcome {
        let Some(ch) = channel else {
            return HecOutcome::Transient(msg);
        };
        if self.ack_committed(ch).await == Some(true) {
            tracing::info!(
                target: "sglake::write",
                reason = %msg,
                "sglake: request failed after the batch was committed; \
                 acknowledged, so not resending"
            );
            return HecOutcome::Ok;
        }
        HecOutcome::Transient(msg)
    }

    /// `Some(true)` when sglake confirms the batch on `channel` reached disk,
    /// `Some(false)` when it says otherwise, `None` when the question itself
    /// could not be answered. Only `Some(true)` suppresses a resend — the
    /// other two both mean "we do not know it landed", which is a resend.
    pub(crate) async fn ack_committed(&self, channel: &str) -> Option<bool> {
        let mut req = self
            .http
            .post(&self.ack_endpoint)
            .query(&[("channel", channel)])
            .json(&serde_json::json!({ "acks": [0] }));
        if !self.token.is_empty() {
            req = req.header("Authorization", format!("Splunk {}", self.token));
        }
        let resp = req.send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let parsed: AckResponse = resp.json().await.ok()?;
        parsed.acks.get("0").copied()
    }
}

fn truncate(s: &str) -> String {
    s.chars().take(300).collect()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// One row of a search result. Values are whatever JSON sglake emitted.
pub(crate) type Row = serde_json::Map<String, serde_json::Value>;

#[derive(Deserialize, Default)]
pub(crate) struct SearchResult {
    /// `results` or `events`, depending on whether the pipeline ended in a
    /// transforming command. Kept for diagnostics.
    #[allow(dead_code)]
    #[serde(default)]
    pub mode: String,
    /// Rows **emitted**, not rows matched — a pipeline redefines it. Page
    /// totals therefore come from a separate `| stats count` query, added in
    /// Phase 2.
    #[allow(dead_code)]
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub rows: Vec<Row>,
    #[serde(default)]
    pub events: Vec<Row>,
}

impl SearchResult {
    /// Rows regardless of which mode the server answered in. Pipelines ending
    /// in `| table` come back as `results`; a bare search comes back as
    /// `events`.
    pub(crate) fn rows(self) -> Vec<Row> {
        if self.rows.is_empty() && !self.events.is_empty() {
            self.events
        } else {
            self.rows
        }
    }
}

/// SPL reader over `/api/v1/search`.
///
/// ⚠️ These endpoints are unauthenticated in sglogd — there is no token to
/// present, unlike HEC. Access control has to come from the network.
pub(crate) struct SearchClient {
    http: reqwest::Client,
    endpoint: String,
    ping_url: String,
}

impl SearchClient {
    pub(crate) fn new(config: &SglakeConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.search_timeout_secs))
            .build()
            .map_err(|e| err("client build", e))?;
        let base = config.url.trim_end_matches('/');
        Ok(Self {
            http,
            endpoint: format!("{base}/api/v1/search"),
            ping_url: format!("{base}/api/v1/indexes"),
        })
    }

    /// Run a query. `earliest` / `latest` are epoch-second strings; `"0"` means
    /// unbounded, which disables bucket pruning and should be avoided on any
    /// path that knows its time range.
    pub(crate) async fn search(
        &self,
        spl: &str,
        earliest: &str,
        latest: &str,
    ) -> Result<SearchResult> {
        let body = serde_json::json!({ "q": spl, "earliest": earliest, "latest": latest });
        let resp = self
            .http
            .post(&self.endpoint)
            .json(&body)
            .send()
            .await
            .map_err(|e| err("search", e))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| err("search", e))?;
        if !status.is_success() {
            return Err(err("search", format!("{status}: {}", truncate(&text))));
        }
        serde_json::from_str(&text).map_err(|e| err("search decode", e))
    }

    /// Unbounded variant, for the few reads whose trait signature carries no
    /// time range (the filter-dropdown distincts).
    pub(crate) async fn search_all_time(&self, spl: &str) -> Result<SearchResult> {
        self.search(spl, "0", "0").await
    }

    pub(crate) async fn ping(&self) -> Result<()> {
        let resp = self
            .http
            .get(&self.ping_url)
            .send()
            .await
            .map_err(|e| err("connect", e))?;
        if !resp.status().is_success() {
            return Err(err(
                "connect",
                format!("{} from {}", resp.status(), self.ping_url),
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Index management (retention)
// ---------------------------------------------------------------------------

/// Per-index settings, over sglake's Splunk-compatible management REST face.
///
/// # This API is not always there
///
/// The whole `/en-US/splunkd/__raw` namespace — this endpoint included — is
/// mounted **only when sglogd finds vendored Splunk frontend assets** at
/// `--splunk-web-dir`. Started without them, every route here answers 404 with
/// an empty body. A deployment that runs sglogd purely as an ingest/search
/// engine therefore cannot be told about retention at all, and Heron has to
/// notice that rather than log a stream of failures. That is what
/// [`Self::list_indexes`] is for: one cheap call that answers both "is this
/// API here?" and "which of my indexes exist yet?".
///
/// # And it is session-authenticated
///
/// When sglogd runs with auth enabled, writes here need a login session cookie
/// plus a CSRF form key — a browser flow, not something a server-side client
/// holds. The HEC token does **not** work. So retention management is
/// supported for the deployment Heron actually documents (sglogd bound to
/// loopback, auth off); anything else gets one clear warning and a no-op.
pub(crate) struct ManagementClient {
    http: reqwest::Client,
    /// `…/services/sglog/settings/indexes`
    settings_url: String,
    /// `…/services/data/indexes`
    list_url: String,
}

/// One index as the management API reports it.
pub(crate) struct IndexInfo {
    pub name: String,
    /// `frozenTimePeriodInSecs` — the TTL after which a bucket is frozen.
    pub frozen_after_secs: Option<i64>,
}

#[derive(Deserialize, Default)]
struct IndexFeed {
    #[serde(default)]
    entry: Vec<IndexEntry>,
}

#[derive(Deserialize)]
struct IndexEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    content: serde_json::Map<String, serde_json::Value>,
}

impl ManagementClient {
    pub(crate) fn new(config: &SglakeConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.request_timeout_secs))
            .build()
            .map_err(|e| err("client build", e))?;
        let base = format!("{}/en-US/splunkd/__raw", config.url.trim_end_matches('/'));
        Ok(Self {
            http,
            settings_url: format!("{base}/services/sglog/settings/indexes"),
            list_url: format!("{base}/services/data/indexes"),
        })
    }

    /// Every index sglake currently knows about, with its retention.
    ///
    /// Doubles as the availability probe — see the type docs. Also the only
    /// way to avoid guessing at 404s: pushing settings to an index that has
    /// never been written to is a 404 that means "not yet", which is
    /// indistinguishable by status code from the 404 that means "this API is
    /// not mounted".
    pub(crate) async fn list_indexes(&self) -> Result<Vec<IndexInfo>> {
        let resp = self
            .http
            .get(&self.list_url)
            .send()
            .await
            .map_err(|e| err("index list", e))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| err("index list", e))?;
        if !status.is_success() {
            return Err(err(
                "index list",
                format!("{status} from {} — {}", self.list_url, truncate(&text)),
            ));
        }
        let feed: IndexFeed = serde_json::from_str(&text).map_err(|e| err("index list", e))?;
        Ok(feed
            .entry
            .into_iter()
            .map(|e| IndexInfo {
                name: e.name,
                frozen_after_secs: e
                    .content
                    .get("frozenTimePeriodInSecs")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok())),
            })
            .collect())
    }

    /// Set one index's retention. `secs` is a TTL from event time, not a
    /// cutoff — sglake freezes a bucket once its newest event is that old.
    pub(crate) async fn set_retention(&self, index: &str, secs: u64) -> Result<()> {
        let resp = self
            .http
            .post(format!("{}/{index}", self.settings_url))
            .form(&[("frozen_after_secs", secs.to_string())])
            .send()
            .await
            .map_err(|e| err("set retention", e))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        Err(err(
            "set retention",
            format!("{status} on index {index}: {}", truncate(&text)),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SglakeConfig {
        SglakeConfig {
            max_body_bytes: 100,
            max_event_bytes: 20,
            ..Default::default()
        }
    }

    #[test]
    fn split_by_bytes_respects_ceiling_and_keeps_order() {
        let c = HecClient::new(&cfg()).unwrap();
        let ev: Vec<String> = (0..10).map(|i| format!("{:0>29}", i)).collect(); // 30B each
        let chunks = c.split_by_bytes(&ev);
        assert!(chunks.len() > 1);
        for ch in &chunks {
            assert!(ch.iter().map(|e| e.len() + 1).sum::<usize>() <= 100 || ch.len() == 1);
        }
        let flat: Vec<&String> = chunks.iter().flat_map(|c| c.iter()).collect();
        assert_eq!(flat.len(), ev.len());
        assert_eq!(*flat[0], ev[0], "order must be preserved");
    }

    /// A single event larger than the ceiling still has to go somewhere:
    /// it becomes its own chunk rather than being silently merged or dropped.
    #[test]
    fn split_by_bytes_isolates_a_single_large_event() {
        let c = HecClient::new(&cfg()).unwrap();
        let ev = vec!["a".repeat(500), "b".into()];
        let chunks = c.split_by_bytes(&ev);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 1);
    }

    #[test]
    fn oversized_events_are_dropped_not_sent() {
        let c = HecClient::new(&cfg()).unwrap();
        let kept = c.enforce_event_size(vec!["ok".into(), "x".repeat(21), "fine".into()]);
        assert_eq!(kept, vec!["ok".to_string(), "fine".to_string()]);
    }

    #[test]
    fn partial_success_response_parses_invalid_event_number() {
        let r: HecResponse = serde_json::from_str(
            r#"{"text":"Invalid data format","code":6,"invalid-event-number":7}"#,
        )
        .unwrap();
        assert_eq!(r.invalid_event_number, Some(7));
        assert_eq!(r.code, 6);

        let ok: HecResponse = serde_json::from_str(r#"{"text":"Success","code":0}"#).unwrap();
        assert_eq!(ok.invalid_event_number, None);
    }

    #[test]
    fn search_result_reads_either_mode() {
        let results: SearchResult =
            serde_json::from_str(r#"{"mode":"results","total":1,"rows":[{"n":5}]}"#).unwrap();
        assert_eq!(results.rows().len(), 1);

        let events: SearchResult =
            serde_json::from_str(r#"{"mode":"events","total":2,"events":[{"a":1},{"a":2}]}"#)
                .unwrap();
        assert_eq!(events.rows().len(), 2);

        let empty: SearchResult = serde_json::from_str(r#"{"mode":"results","total":0}"#).unwrap();
        assert!(empty.rows().is_empty());
    }
}
