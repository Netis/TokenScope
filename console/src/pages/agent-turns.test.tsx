import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseAgentTurnCallItem, baseAgentTurnDetail, baseAgentTurnListItem, baseAgentTurnsPage, renderPage } from "../../test/fixtures"
import { AgentTurnsPage } from "./agent-turns"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. Put more specific paths first. */
function stubTurns(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("AgentTurnsPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading state then populated turn rows", async () => {
    stubTurns({
      "/api/filters/agent-kinds": { values: ["claude-cli"] },
      "/api/traces": baseAgentTurnsPage({ total: 1 }),
    })
    const { container, findByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    expect(container.querySelector("svg")).toBeInTheDocument()
    expect(await findByText("claude-cli")).toBeInTheDocument()
    expect(await findByText("Hello world")).toBeInTheDocument()
    expect(await findByText(/1 of 1/)).toBeInTheDocument()
  })

  it("renders the empty state when there are no agent turns", async () => {
    stubTurns({
      "/api/filters/agent-kinds": { values: [] },
      "/api/traces": { total: 0, items: [] },
    })
    const { findByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    expect(await findByText("No agent turns found in the selected time range")).toBeInTheDocument()
  })

  it("renders the error state when the traces endpoint fails", async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/filters/agent-kinds")) return jsonResponse({ code: 0, message: "ok", data: { values: [] } })
      return jsonResponse({ code: 5, message: "boom" }, { status: 500 })
    })
    const { findByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    expect(await findByText(/Failed to load/i)).toBeInTheDocument()
  })

  it("renders the filter bar with Status, Topology, Surface dropdowns", async () => {
    stubTurns({
      "/api/filters/agent-kinds": { values: ["claude-cli"] },
      "/api/traces": baseAgentTurnsPage(),
    })
    const { findAllByText, findByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    await findByText("claude-cli")
    const statuses = await findAllByText("Status")
    expect(statuses.length).toBeGreaterThanOrEqual(1)
    const topos = await findAllByText("Topology")
    expect(topos.length).toBeGreaterThanOrEqual(1)
    const surfaces = await findAllByText("Surface")
    expect(surfaces.length).toBeGreaterThanOrEqual(1)
    expect(await findByText("Suspicious only")).toBeInTheDocument()
    expect(await findByText("Show proxy hops")).toBeInTheDocument()
  })

  it("renders the proxy badge on a proxied turn row", async () => {
    stubTurns({
      "/api/filters/agent-kinds": { values: [] },
      "/api/traces": baseAgentTurnsPage({
        items: [baseAgentTurnListItem({ turn_id: "t1", proxy_role: "proxy_in", proxy_peer_turn_ids: ["t2"] })],
      }),
    })
    const { findByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    expect(await findByText(/via proxy/i)).toBeInTheDocument()
  })

  it("opens the turn detail panel when a row is clicked", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/traces/turn-1/spans")) return jsonResponse({ code: 0, message: "ok", data: [baseAgentTurnCallItem()] })
      if (u.includes("/api/traces/turn-1")) return jsonResponse({ code: 0, message: "ok", data: baseAgentTurnDetail({ turn_id: "turn-1" }) })
      if (u.includes("/api/traces")) return jsonResponse({ code: 0, message: "ok", data: baseAgentTurnsPage({ total: 1, items: [baseAgentTurnListItem({ turn_id: "turn-1" })] }) })
      if (u.includes("/api/filters/agent-kinds")) return jsonResponse({ code: 0, message: "ok", data: { values: [] } })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText, container } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    await findByText("Hello world")
    const row = container.querySelector("tbody tr") as Element
    await user.click(row)
    await waitFor(() => expect(urls.some((u) => u.includes("/api/traces/turn-1"))).toBe(true))
  })

  it("paginates to the next page via the pager button", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/traces")) return jsonResponse({ code: 0, message: "ok", data: baseAgentTurnsPage({ total: 75 }) })
      if (u.includes("/api/filters/agent-kinds")) return jsonResponse({ code: 0, message: "ok", data: { values: [] } })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    await findByText("Hello world")
    const nextBtn = Array.from(document.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-chevron-right")) as HTMLButtonElement | undefined
    expect(nextBtn).not.toBeUndefined()
    await user.click(nextBtn!)
    await waitFor(() => expect(urls.some((u) => u.includes("page=2"))).toBe(true))
  })

  it("changes the page size via the select", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/traces")) return jsonResponse({ code: 0, message: "ok", data: baseAgentTurnsPage({ total: 75 }) })
      if (u.includes("/api/filters/agent-kinds")) return jsonResponse({ code: 0, message: "ok", data: { values: [] } })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    await findByText("Hello world")
    const sizeSelect = (Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]).find((s) => Array.from(s.options).some((o) => o.value === "100"))
    expect(sizeSelect).not.toBeUndefined()
    await user.selectOptions(sizeSelect!, "100")
    await waitFor(() => expect(urls.some((u) => u.includes("page_size=100"))).toBe(true))
  })

  it("cycles sort order when the Time column header is clicked", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/traces")) return jsonResponse({ code: 0, message: "ok", data: baseAgentTurnsPage({ total: 75 }) })
      if (u.includes("/api/filters/agent-kinds")) return jsonResponse({ code: 0, message: "ok", data: { values: [] } })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText, getByText } = renderPage(<AgentTurnsPage />, { initialEntries: ["/agent-turns"] })
    await findByText("Hello world")
    await user.click(getByText("Time"))
    await waitFor(() => expect(urls.some((u) => u.includes("sort_by="))).toBe(true))
  })
})

