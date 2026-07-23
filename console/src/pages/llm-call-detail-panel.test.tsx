import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseLlmCallDetail, renderPage } from "../../test/fixtures"
import { LlmCallDetailPanel } from "./llm-call-detail-panel"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubDetail(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("LlmCallDetailPanel", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading spinner before detail resolves", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderPage(
      <LlmCallDetailPanel id="call-1" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    expect(container.querySelector("svg")).toBeInTheDocument()
    resolve(jsonResponse({ code: 0, message: "ok", data: baseLlmCallDetail() }))
  })

  it("renders the detail header and Raw HTTP button once resolved", async () => {
    stubDetail({ "/api/spans/call-1": baseLlmCallDetail() })
    const { findByText } = renderPage(
      <LlmCallDetailPanel id="call-1" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    expect(await findByText("LLM Call Detail")).toBeInTheDocument()
    expect(await findByText("Raw HTTP")).toBeInTheDocument()
  })

  it("renders the error state when the detail endpoint fails", async () => {
    mockFetch(() => jsonResponse({ code: 5, message: "not found" }, { status: 500 }))
    const { findByText } = renderPage(
      <LlmCallDetailPanel id="missing" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    expect(await findByText("Failed to load LLM call detail")).toBeInTheDocument()
  })

  it("opens the Raw HTTP drawer when the button is clicked", async () => {
    const user = userEvent.setup()
    stubDetail({ "/api/spans/call-1": baseLlmCallDetail() })
    const { findByText } = renderPage(
      <LlmCallDetailPanel id="call-1" onClose={() => {}} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    await findByText("LLM Call Detail")
    await user.click(await findByText("Raw HTTP"))
    // The drawer renders its body sections.
    expect(await findByText("Request Body")).toBeInTheDocument()
    expect(await findByText("Response Body")).toBeInTheDocument()
  })

  it("invokes onNavigate for prev/next when enabled", async () => {
    const user = userEvent.setup()
    const nav: string[] = []
    stubDetail({ "/api/spans/call-1": baseLlmCallDetail() })
    const { findByText, container } = renderPage(
      <LlmCallDetailPanel id="call-1" onClose={() => {}} onNavigate={(d) => nav.push(d)} hasPrev={true} hasNext={true} />,
    )
    await findByText("LLM Call Detail")
    // prev/next are the chevron-up / chevron-down buttons.
    const up = Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-chevron-up")) as HTMLButtonElement
    const down = Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-chevron-down")) as HTMLButtonElement
    await user.click(up)
    await user.click(down)
    expect(nav).toEqual(["prev", "next"])
  })

  it("invokes onClose when the X close button is clicked", async () => {
    const user = userEvent.setup()
    let closed = 0
    stubDetail({ "/api/spans/call-1": baseLlmCallDetail() })
    const { findByText, container } = renderPage(
      <LlmCallDetailPanel id="call-1" onClose={() => closed++} onNavigate={() => {}} hasPrev={false} hasNext={false} />,
    )
    await findByText("LLM Call Detail")
    const x = Array.from(container.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-x")) as HTMLButtonElement
    await user.click(x)
    await waitFor(() => expect(closed).toBe(1))
  })
})

