import { beforeAll, describe, expect, it } from "bun:test"
import { screen } from "@testing-library/react"

import { ProxyViewTab } from "./proxy-view-tab"
import type {
  AgentTurnCallItem,
  HeaderDiffEntry,
  LatencyBreakdown,
  ProxyViewMember,
  ProxyViewResponse,
} from "@/types/api"
import { jsonResponse, mockFetch, setWindowOrigin } from "../../../test/mocks"
import {
  baseAgentTurnCallItem,
  NOW_MS,
  renderPage,
} from "../../../test/fixtures"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

// ── fixtures ─────────────────────────────────────────────────────────────────
function member(over: Partial<ProxyViewMember> = {}): ProxyViewMember {
  return {
    turn_id: "turn-1",
    role: "proxy_in",
    client_ip: "1.1.1.1",
    client_port: 5000,
    server_ip: "2.2.2.2",
    server_port: 8080,
    start_time: NOW_MS,
    end_time: NOW_MS + 1000,
    duration_ms: 1000,
    ttft_ms: 200,
    e2e_latency_ms: 1000,
    request_model: "claude-sonnet-4",
    wire_api: "anthropic",
    request_path: "/v1/messages",
    status_code: 200,
    request_headers: [],
    response_headers: [],
    ...over,
  }
}

function proxyView(over: Partial<ProxyViewResponse> = {}): ProxyViewResponse {
  return {
    group_id: "g1",
    members: [
      member({ role: "proxy_in", turn_id: "t1" }),
      member({ role: "proxy_out", turn_id: "t2", client_ip: "2.2.2.2", server_ip: "3.3.3.3" }),
    ],
    request_header_diff: [],
    response_header_diff: [],
    latency_breakdown: {
      client_observed_ms: 1000,
      upstream_observed_ms: 800,
      proxy_overhead_ms: 200,
    },
    ...over,
  }
}

function call(seq: number, over: Partial<AgentTurnCallItem> = {}): AgentTurnCallItem {
  return baseAgentTurnCallItem({
    id: `call-${seq}`,
    sequence: seq,
    request_time: NOW_MS,
    complete_time: NOW_MS + 1000,
    e2e_latency_ms: 500,
    ...over,
  })
}

function stubProxyView(payload: ProxyViewResponse) {
  mockFetch((input) => {
    const url = String(input)
    if (url.includes("/proxy-view")) {
      return jsonResponse({ code: 0, message: "ok", data: payload })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

// ── in-turn fallback branch (hasBackendPair = false) ────────────────────────
describe("ProxyViewTab — in-turn fallback (no backend pair)", () => {
  it("renders the InTurnProxyView fallback with the supplied canonicals + hops", () => {
    const c1 = call(1)
    const c2 = call(2)
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([
      [c1.id, [call(11)]],
    ])
    renderPage(
      <ProxyViewTab
        turnId="turn-1"
        hasBackendPair={false}
        canonicalCalls={[c1, c2]}
        hopsByCanonical={hopsByCanonical}
      />,
    )
    // InTurnProxyView surfaces one card for c1 only (c2 has no hops).
    expect(screen.getByText(/Call #1/)).toBeInTheDocument()
    expect(screen.queryByText(/Call #2/)).not.toBeInTheDocument()
  })

  it("renders the no-duplicates notice when no canonical has hops", () => {
    renderPage(
      <ProxyViewTab
        turnId="turn-1"
        hasBackendPair={false}
        canonicalCalls={[call(1)]}
        hopsByCanonical={new Map()}
      />,
    )
    expect(
      screen.getByText(/No call-level proxy duplicates detected/i),
    ).toBeInTheDocument()
  })

  it("renders the no-duplicates notice when canonicalCalls is empty", () => {
    renderPage(
      <ProxyViewTab
        turnId="turn-1"
        hasBackendPair={false}
        canonicalCalls={[]}
        hopsByCanonical={new Map()}
      />,
    )
    expect(
      screen.getByText(/No call-level proxy duplicates detected/i),
    ).toBeInTheDocument()
  })

  it("defaults hopsByCanonical + canonicalCalls to empty when omitted", () => {
    renderPage(<ProxyViewTab turnId="turn-1" hasBackendPair={false} />)
    expect(
      screen.getByText(/No call-level proxy duplicates detected/i),
    ).toBeInTheDocument()
  })
})

// ── backend-pair branch ────────────────────────────────────────────────────
describe("ProxyViewTab — backend pair", () => {
  it("shows the spinner while the proxy-view is loading, then renders the topology", async () => {
    let resolveResponse!: (data: ProxyViewResponse) => void
    mockFetch(() => new Promise<Response>((resolve) => {
      resolveResponse = (data) => resolve(jsonResponse({ code: 0, message: "ok", data }))
    }))
    const { container, findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    // While pending, a Loader2 spinner is rendered (animate-spin).
    expect(container.querySelector(".animate-spin")).not.toBeNull()
    // Now resolve with a populated response.
    resolveResponse(proxyView())
    expect(await findByText(/Topology/i)).toBeInTheDocument()
  })

  it("renders the error notice when the fetch errors", async () => {
    mockFetch(() =>
      jsonResponse({ code: 1, message: "boom", data: null }, { status: 500 }),
    )
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText(/Proxy view unavailable/i)).toBeInTheDocument()
  })

  it("renders the error notice when data is missing", async () => {
    // 200 but data:null → apiFetch throws → useQuery isError path.
    mockFetch(() => jsonResponse({ code: 0, message: "ok", data: null }))
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText(/Proxy view unavailable/i)).toBeInTheDocument()
  })

  it("renders topology member rows with role chips and IPs", async () => {
    stubProxyView(proxyView())
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText("Client-facing")).toBeInTheDocument()
    expect(await findByText("Upstream hop")).toBeInTheDocument()
    // IPs present.
    expect(await findByText(/1\.1\.1\.1:5000 → 2\.2\.2\.2:8080/)).toBeInTheDocument()
  })

  it("renders the latency breakdown stats when provided", async () => {
    stubProxyView(proxyView())
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText("Client observed")).toBeInTheDocument()
    expect(await findByText("Upstream observed")).toBeInTheDocument()
    expect(await findByText("Proxy overhead")).toBeInTheDocument()
  })

  it("omits the latency section when the breakdown is all null", async () => {
    const lb: LatencyBreakdown = {
      client_observed_ms: null,
      upstream_observed_ms: null,
      proxy_overhead_ms: null,
    }
    stubProxyView(proxyView({ latency_breakdown: lb }))
    const { findByText, queryByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    // Topology appears first; latency section is absent.
    expect(await findByText(/Topology/i)).toBeInTheDocument()
    expect(queryByText("Client observed")).not.toBeInTheDocument()
  })

  it("applies the warn tone to the Proxy overhead stat when > 100ms", async () => {
    stubProxyView(proxyView({
      latency_breakdown: { client_observed_ms: 1000, upstream_observed_ms: 700, proxy_overhead_ms: 300 },
    }))
    const { findAllByText, findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText("Proxy overhead")).toBeInTheDocument()
    const val = (await findAllByText("300.0ms"))[0]
    expect(val.className).toContain("text-amber-600")
  })

  it("renders the Model Rewrite banner when rewrite is supplied", async () => {
    stubProxyView(
      proxyView({
        model_rewrite: { client_requested: "claude-sonnet-4", upstream_received: "claude-haiku-3" },
      }),
    )
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText(/Model rewrite/i)).toBeInTheDocument()
    expect(await findByText("claude-sonnet-4")).toBeInTheDocument()
    expect(await findByText("claude-haiku-3")).toBeInTheDocument()
  })

  it("omits the Model Rewrite banner when model_rewrite is absent", async () => {
    stubProxyView(proxyView())
    const { findByText, queryByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText(/Topology/i)).toBeInTheDocument()
    expect(queryByText(/Model rewrite/i)).not.toBeInTheDocument()
  })

  it("renders the Response / Request header diff sections with counts", async () => {
    const modified: HeaderDiffEntry = {
      name: "x-litellm-model",
      kind: "modified",
      values: [
        { turn_id: "t1", role: "proxy_in", value: "claude-sonnet-4" },
        { turn_id: "t2", role: "proxy_out", value: "claude-3-opus" },
      ],
    }
    const perLeg: HeaderDiffEntry = {
      name: "anthropic-request-id",
      kind: "per_leg",
      values: [{ turn_id: "t2", role: "proxy_out", value: "req_abc" }],
    }
    const common: HeaderDiffEntry = {
      name: "content-type",
      kind: "common",
      values: [{ turn_id: "t1", role: "proxy_in", value: "application/json" }],
    }
    stubProxyView(
      proxyView({
        response_header_diff: [modified, perLeg, common],
        request_header_diff: [common],
      }),
    )
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    // Header diff counts in the summary line.
    expect(await findByText(/1 modified · 1 per-leg · 1 common/i)).toBeInTheDocument()
    // Request headers counts.
    expect(await findByText(/0 modified · 0 per-leg · 1 common/i)).toBeInTheDocument()
  })

  it("the header diff renders the KindBadge label for modified entries", async () => {
    const modified: HeaderDiffEntry = {
      name: "host",
      kind: "modified",
      values: [
        { turn_id: "t1", role: "proxy_in", value: "litellm.local" },
        { turn_id: "t2", role: "proxy_out", value: "api.anthropic.com" },
      ],
    }
    stubProxyView(proxyView({ response_header_diff: [modified] }))
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText("modified")).toBeInTheDocument()
  })

  it("the header diff renders the per-leg KindBadge", async () => {
    const perLeg: HeaderDiffEntry = {
      name: "x-trace",
      kind: "per_leg",
      values: [{ turn_id: "t2", role: "proxy_out", value: "trace-1" }],
    }
    stubProxyView(proxyView({ response_header_diff: [perLeg] }))
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText("per leg")).toBeInTheDocument()
  })

  it("the header diff renders a 'absent' row when a leg is missing the header", async () => {
    const perLeg: HeaderDiffEntry = {
      name: "x-only-out",
      kind: "per_leg",
      values: [{ turn_id: "t2", role: "proxy_out", value: "v" }],
    }
    stubProxyView(proxyView({ response_header_diff: [perLeg] }))
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    // The missing leg is rendered as "<role>: absent".
    expect(await findByText(/absent/i)).toBeInTheDocument()
  })

  it("renders the roleChip label for an unknown role as the role string itself", async () => {
    stubProxyView(proxyView({
      members: [member({ role: "weird_role", turn_id: "tX" })],
    }))
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText("weird_role")).toBeInTheDocument()
  })

  it("renders the truncated last-12 chars of each member's turn_id", async () => {
    stubProxyView(proxyView({
      members: [member({ turn_id: "t-very-long-id-1234567890", role: "proxy_in" })],
    }))
    const { findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    // last 12 chars of "t-very-long-id-1234567890" → "d-1234567890"
    expect(await findByText("d-1234567890")).toBeInTheDocument()
  })

  it("renders an arrow icon between members but not after the last", async () => {
    stubProxyView(proxyView({
      members: [
        member({ role: "proxy_in", turn_id: "t1" }),
        member({ role: "proxy_out", turn_id: "t2" }),
      ],
    }))
    const { container, findByText } = renderPage(
      <ProxyViewTab turnId="turn-1" hasBackendPair={true} />,
    )
    expect(await findByText("Client-facing")).toBeInTheDocument()
    // Only one ArrowRightLeft svg between the two members (not after the last).
    expect(container.querySelectorAll(".lucide-arrow-right-left").length).toBe(1)
  })
})
