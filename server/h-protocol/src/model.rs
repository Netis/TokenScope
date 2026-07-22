use bytes::Bytes;
use h_common::process::ProcessInfo;

use crate::net::FlowKey;

/// Events emitted by h-protocol for consumption by h-llm.
#[derive(Debug, Clone)]
pub enum HttpParseEvent {
    /// A complete HTTP request (headers + body) has been parsed.
    HttpRequest(HttpRequestData),
    /// A complete HTTP response (headers + body) has been parsed.
    /// For SSE responses, body contains the raw concatenated SSE text.
    HttpResponse(HttpResponseData),
    /// An individual SSE event from a streaming response.
    SseEvent(SseEventData),
    /// A time-advancing heartbeat. Carries `wall_ts_us` (Unix-epoch µs).
    /// Emitted by each shard when the upstream dispatcher broadcasts a
    /// heartbeat. Downstream stages that are driven by packet timestamps
    /// (turn sweep, metrics window close) use these to make progress during
    /// idle traffic without needing a separate wall-clock ticker.
    Heartbeat { ts: i64, source_id: String },
}

/// A single Server-Sent Event parsed from a `text/event-stream` response.
#[derive(Debug, Clone)]
pub struct SseEventData {
    pub flow_key: FlowKey,
    pub client_addr: (std::net::IpAddr, u16),
    pub server_addr: (std::net::IpAddr, u16),
    /// SSE `event:` field (e.g., "content_block_delta"). Empty if not specified.
    pub event_type: String,
    /// SSE `data:` field content.
    pub data: String,
    pub timestamp_us: i64,
    /// Owning process, stamped by the flow when the source attributes it (eBPF).
    pub process: Option<ProcessInfo>,
}

/// A fully parsed HTTP request.
#[derive(Debug, Clone)]
pub struct HttpRequestData {
    pub flow_key: FlowKey,
    /// Original source (client) IP and port.
    pub client_addr: (std::net::IpAddr, u16),
    /// Original destination (server) IP and port.
    pub server_addr: (std::net::IpAddr, u16),
    pub method: String,
    pub uri: String,
    pub version: u8, // 0 = HTTP/1.0, 1 = HTTP/1.1
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    pub timestamp_us: i64,
    /// Owning process, stamped by the flow when the source attributes it (eBPF).
    pub process: Option<ProcessInfo>,
}

/// A fully parsed HTTP response.
#[derive(Debug, Clone)]
pub struct HttpResponseData {
    pub flow_key: FlowKey,
    /// Original source (client) IP and port (same as the request it answers).
    pub client_addr: (std::net::IpAddr, u16),
    /// Original destination (server) IP and port.
    pub server_addr: (std::net::IpAddr, u16),
    pub status: u16,
    pub version: u8,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    /// Timestamp of the first response byte (for TTFT calculation).
    pub first_byte_timestamp_us: i64,
    /// Timestamp when the response was fully received (for E2E latency).
    pub complete_timestamp_us: i64,
    /// Owning process, stamped by the flow when the source attributes it (eBPF).
    pub process: Option<ProcessInfo>,
}

impl HttpRequestData {
    /// Find a header value by name (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Get Content-Type header.
    pub fn content_type(&self) -> Option<&str> {
        self.header("content-type")
    }
}

impl HttpResponseData {
    /// Find a header value by name (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Get Content-Type header.
    pub fn content_type(&self) -> Option<&str> {
        self.header("content-type")
    }
}

impl HttpParseEvent {
    /// Stamp process attribution onto a content event (request / response / SSE).
    /// A no-op for [`HttpParseEvent::Heartbeat`], which carries no process. The
    /// flow calls this on every event it emits, once it has learned the owning
    /// process from the connection's first attributed packet.
    pub fn set_process(&mut self, process: Option<ProcessInfo>) {
        match self {
            HttpParseEvent::HttpRequest(r) => r.process = process,
            HttpParseEvent::HttpResponse(r) => r.process = process,
            HttpParseEvent::SseEvent(s) => s.process = process,
            HttpParseEvent::Heartbeat { .. } => {}
        }
    }
}

impl std::fmt::Display for HttpParseEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpParseEvent::HttpRequest(req) => {
                write!(
                    f,
                    "[REQ]  {}:{} -> {}:{} | {} {} | {}B",
                    req.client_addr.0,
                    req.client_addr.1,
                    req.server_addr.0,
                    req.server_addr.1,
                    req.method,
                    req.uri,
                    req.body.len(),
                )
            }
            HttpParseEvent::HttpResponse(resp) => {
                let ct = resp.content_type().unwrap_or("-");
                write!(
                    f,
                    "[RESP] {}:{} -> {}:{} | {} | {}B | {ct}",
                    resp.client_addr.0,
                    resp.client_addr.1,
                    resp.server_addr.0,
                    resp.server_addr.1,
                    resp.status,
                    resp.body.len(),
                )
            }
            HttpParseEvent::SseEvent(sse) => {
                let data_preview: String = sse.data.chars().take(80).collect();
                write!(
                    f,
                    "[SSE]  {}:{} -> {}:{} | {} | {}",
                    sse.client_addr.0,
                    sse.client_addr.1,
                    sse.server_addr.0,
                    sse.server_addr.1,
                    sse.event_type,
                    data_preview,
                )
            }
            HttpParseEvent::Heartbeat { ts, source_id } => {
                write!(f, "[HB]   wall_ts_us={ts} source={source_id}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn fk() -> FlowKey {
        FlowKey::new(
            String::new(),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            1234,
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)),
            80,
        )
    }

    fn req(headers: Vec<(&str, &str)>) -> HttpRequestData {
        HttpRequestData {
            flow_key: fk(),
            client_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 1234),
            server_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), 80),
            method: "POST".to_string(),
            uri: "/v1/chat".to_string(),
            version: 1,
            headers: headers
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: Bytes::new(),
            timestamp_us: 0,
            process: None,
        }
    }

    fn resp(headers: Vec<(&str, &str)>) -> HttpResponseData {
        HttpResponseData {
            flow_key: fk(),
            client_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 1234),
            server_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), 80),
            status: 200,
            version: 1,
            headers: headers
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: Bytes::new(),
            first_byte_timestamp_us: 0,
            complete_timestamp_us: 0,
            process: None,
        }
    }

    #[test]
    fn request_header_lookup_is_case_insensitive() {
        let r = req(vec![("Content-Type", "application/json"), ("X-Foo", "bar")]);
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(r.header("CONTENT-TYPE"), Some("application/json"));
        assert_eq!(r.header("x-foo"), Some("bar"));
        assert_eq!(r.header("missing"), None);
        assert_eq!(r.content_type(), Some("application/json"));
    }

    #[test]
    fn response_header_lookup_is_case_insensitive() {
        let r = resp(vec![("Content-Type", "text/event-stream")]);
        assert_eq!(r.header("CONTENT-TYPE"), Some("text/event-stream"));
        assert_eq!(r.content_type(), Some("text/event-stream"));
        assert_eq!(resp(vec![]).content_type(), None);
    }

    #[test]
    fn set_process_stamps_content_events_and_noops_heartbeat() {
        let proc = ProcessInfo::new(42, "node");

        let mut req_ev = HttpParseEvent::HttpRequest(req(vec![]));
        req_ev.set_process(Some(proc.clone()));
        match &req_ev {
            HttpParseEvent::HttpRequest(r) => assert_eq!(r.process.as_ref(), Some(&proc)),
            _ => unreachable!(),
        }

        let mut resp_ev = HttpParseEvent::HttpResponse(resp(vec![]));
        resp_ev.set_process(Some(proc.clone()));
        match &resp_ev {
            HttpParseEvent::HttpResponse(r) => assert_eq!(r.process.as_ref(), Some(&proc)),
            _ => unreachable!(),
        }

        let mut sse_ev = HttpParseEvent::SseEvent(SseEventData {
            flow_key: fk(),
            client_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 1234),
            server_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), 80),
            event_type: "delta".to_string(),
            data: "{}".to_string(),
            timestamp_us: 0,
            process: None,
        });
        sse_ev.set_process(Some(proc.clone()));
        match &sse_ev {
            HttpParseEvent::SseEvent(s) => assert_eq!(s.process.as_ref(), Some(&proc)),
            _ => unreachable!(),
        }

        // Heartbeat carries no process slot — a no-op that must not panic and
        // must leave the variant untouched.
        let mut hb = HttpParseEvent::Heartbeat {
            ts: 7,
            source_id: "src".to_string(),
        };
        hb.set_process(Some(proc));
        match hb {
            HttpParseEvent::Heartbeat { ts, source_id } => {
                assert_eq!(ts, 7);
                assert_eq!(source_id, "src");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn set_process_clears_existing_attribution() {
        let proc = ProcessInfo::new(1, "a");
        let mut r = req(vec![]);
        r.process = Some(ProcessInfo::new(99, "old"));
        r.set_process(Some(proc.clone()));
        assert_eq!(r.process.as_ref(), Some(&proc));
        // Passing None clears it.
        r.set_process(None);
        assert!(r.process.is_none());
    }

    #[test]
    fn display_formats_each_variant() {
        let req_ev = HttpParseEvent::HttpRequest(req(vec![]));
        let s = req_ev.to_string();
        assert!(s.contains("[REQ]"), "{s}");
        assert!(s.contains("POST"), "{s}");
        assert!(s.contains("/v1/chat"), "{s}");

        let resp_ev = HttpParseEvent::HttpResponse(resp(vec![("content-type", "text/plain")]));
        let s = resp_ev.to_string();
        assert!(s.contains("[RESP]"), "{s}");
        assert!(s.contains("200"), "{s}");
        assert!(s.contains("text/plain"), "{s}");
        // A response with no content-type falls back to "-".
        let s_no_ct = HttpParseEvent::HttpResponse(resp(vec![])).to_string();
        assert!(s_no_ct.contains("[RESP]"), "{s_no_ct}");
        assert!(s_no_ct.contains(" | -"), "{s_no_ct}");

        let sse_ev = HttpParseEvent::SseEvent(SseEventData {
            flow_key: fk(),
            client_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 1234),
            server_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), 80),
            event_type: "content_block_delta".to_string(),
            data: "{\"x\":1}".to_string(),
            timestamp_us: 0,
            process: None,
        });
        let s = sse_ev.to_string();
        assert!(s.contains("[SSE]"), "{s}");
        assert!(s.contains("content_block_delta"), "{s}");
        assert!(s.contains("{\"x\":1}"), "{s}");

        let hb = HttpParseEvent::Heartbeat {
            ts: 1_700_000_000_000_000,
            source_id: "src1".to_string(),
        };
        let s = hb.to_string();
        assert!(s.contains("[HB]"), "{s}");
        assert!(s.contains("wall_ts_us=1700000000000000"), "{s}");
        assert!(s.contains("source=src1"), "{s}");
    }

    #[test]
    fn sse_display_truncates_long_data_to_80_chars() {
        let long = "a".repeat(200);
        let sse_ev = HttpParseEvent::SseEvent(SseEventData {
            flow_key: fk(),
            client_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 1234),
            server_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), 80),
            event_type: "e".to_string(),
            data: long,
            timestamp_us: 0,
            process: None,
        });
        let s = sse_ev.to_string();
        let preview_len = s.split('|').last().unwrap().trim().len();
        assert_eq!(preview_len, 80, "preview must be capped at 80 chars: {s}");
        // And a short payload is rendered in full.
        let short_s = HttpParseEvent::SseEvent(SseEventData {
            flow_key: fk(),
            client_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 1234),
            server_addr: (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), 80),
            event_type: "e".to_string(),
            data: "hi".to_string(),
            timestamp_us: 0,
            process: None,
        })
        .to_string();
        assert!(short_s.contains(" | hi"), "{short_s}");
    }
}
