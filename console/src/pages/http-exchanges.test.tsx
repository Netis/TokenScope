import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseHttpExchangeDetail, baseHttpExchangeListItem, baseHttpExchangesPage, renderPage } from "../../test/fixtures"
import { HttpExchangesPage } from "./http-exchanges"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("HttpExchangesPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading state then populated exchange rows", async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/http-exchanges")) return jsonResponse({ code: 0, message: "ok", data: baseHttpExchangesPage({ total: 1 }) })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { container, findByText } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    expect(container.querySelector("svg")).toBeInTheDocument()
    expect(await findByText("/v1/chat/completions")).toBeInTheDocument()
    expect(await findByText(/1 of 1/)).toBeInTheDocument()
  })

  it("renders the empty state when there are no HTTP logs", async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/http-exchanges")) return jsonResponse({ code: 0, message: "ok", data: { total: 0, items: [] } })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    expect(await findByText("No HTTP logs in the selected time range")).toBeInTheDocument()
  })

  it("renders the error state when the endpoint fails", async () => {
    mockFetch(() => jsonResponse({ code: 5, message: "boom" }, { status: 500 }))
    const { findByText } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    expect(await findByText(/Failed to load/i)).toBeInTheDocument()
  })

  it("renders the filter bar with Method and Status dropdowns", async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/http-exchanges")) return jsonResponse({ code: 0, message: "ok", data: baseHttpExchangesPage() })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findAllByText, findByText } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    await findByText("/v1/chat/completions")
    const methods = await findAllByText("Method")
    expect(methods.length).toBeGreaterThanOrEqual(1)
    const statuses = await findAllByText("Status")
    expect(statuses.length).toBeGreaterThanOrEqual(1)
    expect(await findByText("Filters:")).toBeInTheDocument()
  })

  it("opens the exchange detail panel when a row is clicked", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      // detail route first (more specific)
      if (u.includes("/api/http-exchanges/ex-1")) return jsonResponse({ code: 0, message: "ok", data: baseHttpExchangeDetail({ id: "ex-1" }) })
      if (u.includes("/api/http-exchanges")) return jsonResponse({ code: 0, message: "ok", data: baseHttpExchangesPage({ total: 1, items: [baseHttpExchangeListItem({ id: "ex-1" })] }) })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText, container } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    await findByText("/v1/chat/completions")
    const row = container.querySelector("tbody tr") as Element
    await user.click(row)
    await waitFor(() => expect(urls.some((u) => u.includes("/api/http-exchanges/ex-1"))).toBe(true))
  })

  it("paginates to the next page via the pager button", async () => {
    const user = userEvent.setup()
    const urls: string[] = []
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      if (u.includes("/api/http-exchanges")) return jsonResponse({ code: 0, message: "ok", data: baseHttpExchangesPage({ total: 75 }) })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    await findByText("/v1/chat/completions")
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
      if (u.includes("/api/http-exchanges")) return jsonResponse({ code: 0, message: "ok", data: baseHttpExchangesPage({ total: 75 }) })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    await findByText("/v1/chat/completions")
    const sizeSelect = (Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]).find((s) => Array.from(s.options).some((o) => o.value === "100"))
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
      if (u.includes("/api/http-exchanges")) return jsonResponse({ code: 0, message: "ok", data: baseHttpExchangesPage({ total: 75 }) })
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { findByText, getByText } = renderPage(<HttpExchangesPage />, { initialEntries: ["/http-exchanges"] })
    await findByText("/v1/chat/completions")
    // "Time" is the first sortable column (request_time).
    await user.click(getByText("Time"))
    await waitFor(() => expect(urls.some((u) => u.includes("sort_by="))).toBe(true))
  })
})

