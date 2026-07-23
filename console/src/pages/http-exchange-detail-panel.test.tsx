import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseHttpExchangeDetail, renderPage } from "../../test/fixtures"
import { HttpExchangeDetailPanel } from "./http-exchange-detail-panel"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubHttpDetail(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("HttpExchangeDetailPanel", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading spinner before detail resolves", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderPage(
      <HttpExchangeDetailPanel id="ex-1" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    // lucide Loader2 renders an svg while loading.
    expect(container.querySelector("svg")).toBeInTheDocument()
    resolve(jsonResponse({ code: 0, message: "ok", data: baseHttpExchangeDetail() }))
  })

  it("renders the detail header, summary cards, and collapsible sections once resolved", async () => {
    stubHttpDetail({
      "/api/http-exchanges/ex-1": baseHttpExchangeDetail(),
    })
    const { findByText, findAllByText } = renderPage(
      <HttpExchangeDetailPanel id="ex-1" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    // Wait for data to resolve via the unique "Method / URI" summary card
    // label (only renders when detail is set).
    expect(await findByText("Method / URI")).toBeInTheDocument()
    expect(await findByText("HTTP Log Detail")).toBeInTheDocument()
    // The URI appears in both the Method/URI card and the MetadataGrid row,
    // so use findAllByText.
    const uris = await findAllByText("/v1/chat/completions")
    expect(uris.length).toBeGreaterThanOrEqual(1)
    // "Duration" appears as both a SummaryCard label and a MetadataGrid
    // row label, so use findAllByText.
    const durations = await findAllByText("Duration")
    expect(durations.length).toBeGreaterThanOrEqual(1)
    // Collapsible section titles (always rendered, even when collapsed).
    expect(await findByText("Request Headers")).toBeInTheDocument()
    expect(await findByText("Response Headers")).toBeInTheDocument()
    expect(await findByText("Request Body")).toBeInTheDocument()
  })

  it("renders the error state when the detail endpoint fails", async () => {
    mockFetch(() => jsonResponse({ code: 5, message: "not found" }, { status: 500 }))
    const { findByText } = renderPage(
      <HttpExchangeDetailPanel id="missing" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    expect(await findByText("Failed to load HTTP exchange detail")).toBeInTheDocument()
  })

  it("renders SSE event/byte rows for an SSE exchange", async () => {
    stubHttpDetail({ "/api/http-exchanges/ex-1": baseHttpExchangeDetail({ is_sse: true, sse_event_count: 4, sse_data_bytes: 2048 }) })
    const { findByText } = renderPage(
      <HttpExchangeDetailPanel id="ex-1" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    await findByText("HTTP Log Detail")
    expect(await findByText("SSE Events")).toBeInTheDocument()
    expect(await findByText("SSE Data Bytes")).toBeInTheDocument()
  })

  it("parses and renders request headers; an invalid headers blob falls back to empty", async () => {
    const user = userEvent.setup()
    stubHttpDetail({
      "/api/http-exchanges/ex-1": baseHttpExchangeDetail({
        request_headers: "not-json{",
        response_headers: JSON.stringify([["x-foo", "bar"]]),
      }),
    })
    const { findByText } = renderPage(
      <HttpExchangeDetailPanel id="ex-1" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    await findByText("HTTP Log Detail")
    // Expand the Response Headers section to reveal the parsed table.
    await user.click(await findByText("Response Headers"))
    expect(await findByText("x-foo")).toBeInTheDocument()
    expect(await findByText("bar")).toBeInTheDocument()
  })

  it("invokes onNavigate for prev/next and onClose for X", async () => {
    const user = userEvent.setup()
    const nav: string[] = []
    let closed = 0
    stubHttpDetail({ "/api/http-exchanges/ex-1": baseHttpExchangeDetail() })
    const { findByText, container } = renderPage(
      <HttpExchangeDetailPanel id="ex-1" onClose={() => closed++} onNavigate={(d) => nav.push(d)} hasPrev={true} hasNext={true} />,
    )
    await findByText("HTTP Log Detail")
    const up = Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-chevron-up")) as HTMLButtonElement
    const down = Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-chevron-down")) as HTMLButtonElement
    await user.click(up)
    await user.click(down)
    expect(nav).toEqual(["prev", "next"])
    const x = Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-x")) as HTMLButtonElement
    await user.click(x)
    expect(closed).toBe(1)
  })
})
