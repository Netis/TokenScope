import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseRuntimeConfig, renderPage } from "../../test/fixtures"
import { RuntimeConfigPage } from "./debug-runtime-config"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubRuntimeConfig(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("RuntimeConfigPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading spinner before config resolves", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderPage(<RuntimeConfigPage />, {
      initialEntries: ["/debug/runtime-config"],
    })
    // lucide Loader2 renders an svg while loading.
    expect(container.querySelector("svg")).toBeInTheDocument()
    resolve(jsonResponse({ code: 0, message: "ok", data: baseRuntimeConfig() }))
  })

  it("renders the header and JSON body once config resolves", async () => {
    stubRuntimeConfig({
      "/api/runtime-config": baseRuntimeConfig(),
    })
    const { findByText } = renderPage(<RuntimeConfigPage />, {
      initialEntries: ["/debug/runtime-config"],
    })
    expect(await findByText("Runtime Config")).toBeInTheDocument()
    // The config_path renders in the header.
    expect(await findByText("/etc/heron/default.toml")).toBeInTheDocument()
    // Copy / Refresh buttons.
    expect(await findByText("Copy JSON")).toBeInTheDocument()
    expect(await findByText("Refresh")).toBeInTheDocument()
  })

  it("renders the error state when the config endpoint fails", async () => {
    mockFetch(() => jsonResponse({ code: 5, message: "boom" }, { status: 500 }))
    const { findByText } = renderPage(<RuntimeConfigPage />, {
      initialEntries: ["/debug/runtime-config"],
    })
    expect(await findByText(/Failed to load runtime config/)).toBeInTheDocument()
  })

  it("copies the JSON to the clipboard when the Copy button is clicked", async () => {
    const user = userEvent.setup()
    let written = ""
    ;(globalThis as unknown as { navigator: { clipboard: { writeText: (s: string) => Promise<void> } } }).navigator.clipboard.writeText = (s: string) => {
      written = s
      return Promise.resolve()
    }
    stubRuntimeConfig({ "/api/runtime-config": baseRuntimeConfig() })
    const { findByText } = renderPage(<RuntimeConfigPage />, { initialEntries: ["/debug/runtime-config"] })
    await findByText("Runtime Config")
    await user.click(await findByText("Copy JSON"))
    // The clipboard received the serialized config.
    expect(written).toContain("pipelines")
  })
})
