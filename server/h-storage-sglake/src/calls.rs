//! `spans` — write path.
//!
//! One call becomes up to two events in two different indexes: metadata in
//! `<prefix>_spans` and, when there is anything to store, bodies+headers in
//! `<prefix>_bodies`.
//!
//! The metadata event is ordered **before** its body event in the batch. HEC
//! ingests a batch in order and stops at the first malformed event, so a
//! partial failure can leave a span without its body (the console then shows
//! the body as unavailable) but never a body without its span.

use h_common::error::Result;
use h_llm::model::LlmCall;

use crate::rows::{span_events, Envelope, ST_BODY, ST_SPAN};
use crate::SglakeBackend;

impl SglakeBackend {
    pub(crate) async fn write_spans(&self, calls: Vec<LlmCall>) -> Result<()> {
        if calls.is_empty() {
            return Ok(());
        }
        let mut events = Vec::with_capacity(calls.len() * 2);
        for call in &calls {
            let (meta, body) = span_events(call, self.store_bodies);
            let ts = call.request_time;
            let host = call.source_id.clone();

            match Envelope::new(ts, &host, ST_SPAN, &self.ix.spans, meta).encode() {
                Ok(s) => events.push(s),
                Err(e) => {
                    // Encoding a span cannot normally fail; if it does, drop
                    // just this one rather than the whole batch.
                    tracing::error!(
                        target: "sglake::write", id = %call.id, error = %e,
                        "sglake: failed to encode span event; skipping it"
                    );
                    continue;
                }
            }
            if let Some(body) = body {
                match Envelope::new(ts, &host, ST_BODY, &self.ix.bodies, body).encode() {
                    Ok(s) => events.push(s),
                    Err(e) => tracing::error!(
                        target: "sglake::write", id = %call.id, error = %e,
                        "sglake: failed to encode body event; span metadata still written"
                    ),
                }
            }
        }
        self.hec.send(events).await
    }
}
