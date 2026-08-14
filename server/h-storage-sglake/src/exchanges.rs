//! `http_exchanges` — write path and by-id lookup.
//!
//! Same metadata/body split as spans, and the same ordering guarantee: the
//! metadata event precedes its body event in the batch, so a partial ingest
//! can lose a body but never orphan one.
//!
//! Unlike every other read here, `HttpExchangeDetail` carries **microsecond**
//! timestamps rather than milliseconds — the raw HTTP view is where sub-ms
//! timing is the point.

use h_common::error::Result;
use h_protocol::HttpExchange;
use h_storage::query::HttpExchangeDetail;

use crate::rows::{http_events, Envelope, HttpBodyEvent, HttpEvent, ST_HTTP, ST_HTTP_BODY};
use crate::spl::match_term;
use crate::SglakeBackend;

impl SglakeBackend {
    pub(crate) async fn write_exchanges(&self, exchanges: Vec<HttpExchange>) -> Result<()> {
        if exchanges.is_empty() {
            return Ok(());
        }
        let mut events = Vec::with_capacity(exchanges.len() * 2);
        for x in &exchanges {
            let (meta, body) = http_events(x, self.store_bodies);
            let ts = x.request.timestamp_us;
            let host = x.request.flow_key.source_id.clone();

            match Envelope::new(ts, &host, ST_HTTP, &self.ix.http, meta).encode() {
                Ok(s) => events.push(s),
                Err(e) => {
                    tracing::error!(
                        target: "sglake::write", id = %x.id, error = %e,
                        "sglake: failed to encode http exchange; skipping it"
                    );
                    continue;
                }
            }
            if let Some(body) = body {
                match crate::rows::raw_envelope(
                    ts,
                    &host,
                    ST_HTTP_BODY,
                    &self.ix.http_bodies,
                    &body,
                ) {
                    Ok(s) => events.push(s),
                    Err(e) => tracing::error!(
                        target: "sglake::write", id = %x.id, error = %e,
                        "sglake: failed to encode http body; metadata still written"
                    ),
                }
            }
        }
        self.hec.send(events).await
    }

    pub(crate) async fn query_http_exchange_by_id(
        &self,
        id: &str,
    ) -> Result<Option<HttpExchangeDetail>> {
        let ix = &self.ix.http;
        let Some(term) = match_term("id", id) else {
            return Ok(None);
        };
        let search = format!("search index={ix} sourcetype={ST_HTTP} {term}");
        let Some(e) = self
            .fetch_raw_by_id::<HttpEvent>("query_http_exchange_by_id", &search, 1, id)
            .await?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };

        let body = if e.has_body {
            let bix = &self.ix.http_bodies;
            let Some(bterm) = match_term("span_id", id) else {
                return Ok(None);
            };
            let bsearch = format!("search index={bix} sourcetype={ST_HTTP_BODY} {bterm}");
            self.fetch_raw_by_id::<HttpBodyEvent>("query_http_exchange_body", &bsearch, 1, id)
                .await?
                .into_iter()
                .next()
        } else {
            None
        };
        // Headers are non-optional on the detail type. An exchange written
        // with bodies disabled has none stored, and an empty JSON array is the
        // honest answer — the same shape the parser produces for a request
        // that genuinely carried no headers.
        let body = body.unwrap_or(HttpBodyEvent {
            span_id: e.id.clone(),
            request_headers: "[]".into(),
            response_headers: "[]".into(),
            request_body: None,
            response_body: None,
        });

        Ok(Some(HttpExchangeDetail {
            id: e.id,
            source_id: e.source_id,
            client_ip: e.client_ip,
            client_port: e.client_port,
            server_ip: e.server_ip,
            server_port: e.server_port,
            method: e.method,
            uri: e.uri,
            request_headers: body.request_headers,
            request_body: body.request_body,
            status: e.status,
            response_headers: body.response_headers,
            response_body: body.response_body,
            is_sse: e.is_sse,
            sse_event_count: e.sse_event_count,
            sse_data_bytes: e.sse_data_bytes,
            request_time: e.ts_us,
            response_first_byte_time: e.first_byte_us,
            response_complete_time: e.done_us,
        }))
    }
}
