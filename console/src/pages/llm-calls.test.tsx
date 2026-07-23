import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseLlmCallDetail, baseLlmCallListItem, baseLlmCallsPage, renderPage } from "../../test/fixtures"
import { LlmCallsPage } from "./llm-calls"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubCalls(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

/** A multi-row page for pagination/sort tests (3 items, total large). */
function multiRowPage() {
  return baseLlmCallsPage({
    total: 75,
    items: [
      baseLlmCallListItem({ id: "c1", request_time: 1_780_000_000_000, model: "aaa-model", ttft_ms: 300, e2e_latency_ms: 2000, input_tokens: 10, output_tokens: 5, status_code: 200, tokens_estimated: false }),
      baseLlmCallListItem({ id: "c2", request_time: 1_780_000_001_000, model: "bbb-model", ttft_ms: 400, e2e_latency_ms: 3000, input_tokens: 20, output_tokens: 8, status_code: 429, tokens_estimated: true, process: { pid: 99, comm: "node", exe: "/usr/bin/node" } }),
      baseLlmCallListItem({ id: "c3", request_time: 1_780_000_002_000, model: "ccc-model", ttft_ms: null, e2e_latency_ms: null, input_tokens: null, output_tokens: null, status_code: 500 }),
    ],
  })
}

describe("LlmCallsPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading state then populated rows", async () => {
    stubCalls({
      "/api/spans": baseLlmCallsPage({ total: 1 }),
      "/api/filters/finish-reasons": { pairs: [] },
    })
    const { container, findByText } = renderPage(<LlmCallsPage />, {
      initialEntries: ["/llm-calls"],
    })
    expect(container.querySelector("svg")).toBeInTheDocument()
    expect(await findByText("claude-sonnet-4")).toBeInTheDocument()
    expect(await findByText(/1 of 1/)).toBeInTheDocument()
  })

  it("renders the empty state when there are no LLM calls", async () => {
    stubCalls({
      "/api/spans": { total: 0, items: [] },
      "/api/filters/finish-reasons": { pairs: [] },
    })
    const { findByText } = renderPage(<LlmCallsPage />, {
      initialEntries: ["/llm-calls"],
    })
    expect(await findByText("No LLM calls found in the selected time range")).toBeInTheDocument()
  })

  it("renders the error state when the spans endpoint fails", async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/spans")) return jsonResponse({ code: 5, message: "boom" }, { status: 500 })
      return jsonResponse({ code: 0, message: "ok", data: { pairs: [] } })
    })
    const { findByText } = renderPage(<LlmCallsPage />, { initialEntries: ["/llm-calls"] })
    expect(await findByText(/Failed to load LLM calls/i)).toBeInTheDocument()
  })

  it("renders the filter bar with Status and Finish Reason dropdowns", async () => {
    stubCalls({
      "/api/spans": baseLlmCallsPage(),
      "/api/filters/finish-reasons": { pairs: [] },
    })
    const { findAllByText, findByText } = renderPage(<LlmCallsPage />, {
      initialEntries: ["/llm-calls"],
    })
    const statuses = await findAllByText("Status")
    expect(statuses.length).toBeGreaterThanOrEqual(1)
    expect(await findByText("Finish Reason")).toBeInTheDocument()
    expect(await findByText("Filters:")).toBeInTheDocument()
  })

  it("renders the estimated-tokens tilde and process attribution", async () => {
    stubCalls({
      "/api/spans": multiRowPage(),
      "/api/filters/finish-reasons": { pairs: [] },
    })
    const { findByText } = renderPage(<LlmCallsPage />, { initialEntries: ["/llm-calls"] })
    // c2 has tokens_estimated → "~" prefix on tokens.
    expect(await findByText("aaa-model")).toBeInTheDocument()
    // process comm "node" rendered in the Process column.
    expect(await findByText("node")).toBeInTheDocument()
  })

  it("opens the call detail panel when a row is clicked", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/spans/c1")) return jsonResponse({ code: 0, message: "ok", data: baseLlmCallDetail() })
      if (u.includes("/api/spans")) return jsonResponse({ code: 0, message: "ok", data: baseLlmCallsPage({ total: 1, items: [baseLlmCallListItem({ id: "c1" })] }) })
      return jsonResponse({ code: 0, message: "ok", data: { pairs: [] } })
    })
    const { findByText, container } = renderPage(<LlmCallsPage />, { initialEntries: ["/llm-calls"] })
    await findByText("claude-sonnet-4")
    // Click the row.
    const row = container.querySelector("tbody tr") as Element
    expect(row).not.toBeNull()
    await user.click(row)
    // The detail panel fetches /api/spans/c1 (a span-by-id request).
    await waitFor(() => expect(urls.some((u) => u.includes("/api/spans/c1"))).toBe(true))
  })

  it("paginates to the next page via the pager button", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/filters/finish-reasons")) return jsonResponse({ code: 0, message: "ok", data: { pairs: [] } })
      return jsonResponse({ code: 0, message: "ok", data: multiRowPage() })
    })
    const { findByText } = renderPage(<LlmCallsPage />, { initialEntries: ["/llm-calls"] })
    await findByText("aaa-model")
    // The next-page button carries the chevron-right icon.
    const btns = document.querySelectorAll("button")
    const nextBtn = Array.from(btns).find((b) => b.querySelector("svg.lucide-chevron-right")) as HTMLButtonElement | undefined
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
      if (u.includes("/api/filters/finish-reasons")) return jsonResponse({ code: 0, message: "ok", data: { pairs: [] } })
      return jsonResponse({ code: 0, message: "ok", data: multiRowPage() })
    })
    const { findByText } = renderPage(<LlmCallsPage />, { initialEntries: ["/llm-calls"] })
    await findByText("aaa-model")
    // The page-size select is the one whose options include "100".
    const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]
    const sizeSelect = selects.find((s) => Array.from(s.options).some((o) => o.value === "100"))
    expect(sizeSelect).not.toBeUndefined()
    await user.selectOptions(sizeSelect!, "100")
    await waitFor(() => expect(urls.some((u) => u.includes("page_size=100"))).toBe(true))
  })

  it("cycles sort order when a sortable column header is clicked", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/filters/finish-reasons")) return jsonResponse({ code: 0, message: "ok", data: { pairs: [] } })
      return jsonResponse({ code: 0, message: "ok", data: multiRowPage() })
    })
    const { findByText, getByText } = renderPage(<LlmCallsPage />, { initialEntries: ["/llm-calls"] })
    await findByText("aaa-model")
    // Click the TTFT sortable header.
    await user.click(getByText("TTFT"))
    await waitFor(() => expect(urls.some((u) => u.includes("sort_by=ttft_ms"))).toBe(true))
  })
})

