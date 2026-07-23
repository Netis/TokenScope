import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseAgentTurnCallItem, baseAgentTurnDetail, renderPage } from "../../test/fixtures"
import { AgentTurnDetailPanel } from "./agent-turn-detail-panel"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. Put more specific paths first. */
function stubTurnDetail(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

/** Two calls that groupCalls() will fold into one canonical + one hop:
 *  same content fingerprint + request_times within 100ms + DIFFERENT
 *  5-tuple (client_ip:port, server_ip:port) — the pairing rule requires
 *  distinct network views. */
function hopPair() {
  const a = baseAgentTurnCallItem({
    id: "call-a", sequence: 1,
    request_time: 1_780_000_000_000,
    complete_time: 1_780_000_002_000, // 2000ms span (longer → canonical)
    client_ip: "10.0.0.9", client_port: 50000,
    server_ip: "10.0.0.1", server_port: 8080,
  })
  const b = baseAgentTurnCallItem({
    id: "call-b", sequence: 2,
    request_time: 1_780_000_000_010,
    complete_time: 1_780_000_000_510, // 500ms span → hop
    client_ip: "10.0.0.1", client_port: 50001,
    server_ip: "10.0.0.2", server_port: 8080,
  })
  return [a, b]
}

describe("AgentTurnDetailPanel", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading spinner before the turn resolves", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderPage(
      <AgentTurnDetailPanel id="turn-1" onClose={() => {}} />,
    )
    expect(container.querySelector("svg")).toBeInTheDocument()
    resolve(jsonResponse({ code: 0, message: "ok", data: baseAgentTurnDetail() }))
  })

  it("renders the turn detail panel with calls once resolved", async () => {
    stubTurnDetail({
      "/api/traces/turn-1/spans": [baseAgentTurnCallItem()],
      "/api/traces/turn-1": baseAgentTurnDetail({ user_input: "Hello world" }),
    })
    const { findByText } = renderPage(
      <AgentTurnDetailPanel id="turn-1" onClose={() => {}} />,
    )
    expect(await findByText("Hello world")).toBeInTheDocument()
  })

  it("renders the error state when the turn endpoint fails", async () => {
    mockFetch(() => jsonResponse({ code: 5, message: "not found" }, { status: 500 }))
    const { findByText } = renderPage(
      <AgentTurnDetailPanel id="missing" onClose={() => {}} />,
    )
    expect(await findByText("Failed to load agent turn detail")).toBeInTheDocument()
    expect(await findByText("Close")).toBeInTheDocument()
  })

  it("renders the loading skeleton rows while calls load", async () => {
    // Turn resolves immediately but spans hang so loadingCalls stays true
    // and calls.length === 0 → skeleton rows.
    let resolveSpans: (v: unknown) => void = () => {}
    const pendingSpans = new Promise<unknown>((r) => { resolveSpans = r })
    // spans route MUST be matched before the broader turn route.
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/traces/turn-1/spans")) return pendingSpans as Promise<Response>
      if (url.includes("/api/traces/turn-1")) return jsonResponse({ code: 0, message: "ok", data: baseAgentTurnDetail() })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { container } = renderPage(
      <AgentTurnDetailPanel id="turn-1" onClose={() => {}} />,
    )
    // The skeleton rows are pulsing divs.
    await waitFor(() =>
      expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0),
    )
    resolveSpans(jsonResponse({ code: 0, message: "ok", data: [] }))
  })

  it("renders the no-calls notice when the call list is empty", async () => {
    stubTurnDetail({
      "/api/traces/turn-1/spans": [],
      "/api/traces/turn-1": baseAgentTurnDetail({ call_count: 0 }),
    })
    const { findAllByText } = renderPage(
      <AgentTurnDetailPanel id="turn-1" onClose={() => {}} />,
    )
    // "No calls" appears in the calls list; assert at least one.
    const els = await findAllByText("No calls")
    expect(els.length).toBeGreaterThan(0)
  })

  it("renders the lite-mode notice for large turns", async () => {
    stubTurnDetail({
      "/api/traces/turn-1/spans": [baseAgentTurnCallItem()],
      "/api/traces/turn-1": baseAgentTurnDetail({ call_count: 250 }),
    })
    const { findByText } = renderPage(
      <AgentTurnDetailPanel id="turn-1" onClose={() => {}} />,
    )
    expect(await findByText(/Large turn/i)).toBeInTheDocument()
  })

  it("shows the proxy tab + fold checkbox when hops are grouped", async () => {
    stubTurnDetail({
      "/api/traces/turn-1/spans": hopPair(),
      "/api/traces/turn-1": baseAgentTurnDetail({ user_input: "Hello world" }),
    })
    const { findByText, findByRole, queryByText } = renderPage(
      <AgentTurnDetailPanel id="turn-1" onClose={() => {}} />,
    )
    // Tab buttons render.
    expect(await findByRole("button", { name: /Calls/i })).toBeInTheDocument()
    expect(await findByRole("button", { name: /Proxy view/i })).toBeInTheDocument()
    // Fold checkbox label present.
    expect(await findByText(/Show proxy hops/i)).toBeInTheDocument()
    // Click the Proxy view tab → renders the proxy view content.
    await userEvent.setup().click(await findByRole("button", { name: /Proxy view/i }))
    await waitFor(() => expect(queryByText(/Show proxy hops/i)).not.toBeInTheDocument())
  })

  it("closes the panel when the backdrop is clicked", async () => {
    const user = userEvent.setup()
    let closed = 0
    stubTurnDetail({
      "/api/traces/turn-1/spans": [baseAgentTurnCallItem()],
      "/api/traces/turn-1": baseAgentTurnDetail(),
    })
    const { container } = renderPage(
      <AgentTurnDetailPanel id="turn-1" onClose={() => closed++} />,
    )
    // Wait for the turn to load (so the backdrop is the first fixed layer).
    await waitFor(() => expect(container.querySelector(".animate-pulse") ?? container.querySelector("section") ?? container.querySelector("svg")).not.toBeNull())
    // The backdrop is the first child div with bg-black/20.
    const backdrop = container.querySelector(".bg-black\\/20") as Element | null
    expect(backdrop).not.toBeNull()
    await user.click(backdrop!)
    expect(closed).toBeGreaterThan(0)
  })
})

