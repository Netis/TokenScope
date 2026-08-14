//! HTTP clients: [`HecClient`] for writes, [`SearchClient`] for reads.
//!
//! Both wrap one `reqwest::Client` each (internally an `Arc`'d connection
//! pool). We deliberately do not reuse sglog's own `sglog-agent` HEC client:
//! it opens a fresh TCP connection per request, cannot do TLS or gzip, and
//! discards the response body — but the response body is exactly what the
//! retry state machine needs, since a partial-success 400 carries the index of
//! the first bad event.

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
pub(crate) struct HecClient {
    http: reqwest::Client,
    endpoint: String,
    token: String,
    max_body_bytes: usize,
    max_event_bytes: usize,
    gzip: bool,
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

impl HecClient {
    pub(crate) fn new(config: &SglakeConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.request_timeout_secs))
            .build()
            .map_err(|e| err("client build", e))?;
        Ok(Self {
            http,
            endpoint: format!(
                "{}/services/collector/event",
                config.url.trim_end_matches('/')
            ),
            token: config.hec_token.clone(),
            max_body_bytes: config.max_body_bytes,
            max_event_bytes: config.max_event_bytes,
            gzip: config.gzip,
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

        let mut req = self.http.post(&self.endpoint);
        if !self.token.is_empty() {
            req = req.header("Authorization", format!("Splunk {}", self.token));
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
            Err(e) => return HecOutcome::Transient(e.to_string()),
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
            return HecOutcome::Transient(format!("{status}: {}", truncate(&text)));
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
