import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseTimeseries, renderPage } from "../../test/fixtures"
import { PerformancePage } from "./performance"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch to return the given payload keyed by URL substring. */
function stubPerformance(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("PerformancePage", () => {
  afterEach(() => {
    // mockFetch self-restores; nothing extra needed.
  })

  it("renders all six chart section titles", async () => {
    stubPerformance({
      "/api/metrics/timeseries": baseTimeseries(),
    })
    const { findByText } = renderPage(<PerformancePage />, {
      initialEntries: ["/performance"],
    })
    expect(await findByText("Stream TTFT Distribution")).toBeInTheDocument()
    expect(await findByText("E2E Latency Distribution")).toBeInTheDocument()
    expect(await findByText("TPOT (Time Per Output Token)")).toBeInTheDocument()
    expect(await findByText("Active Calls")).toBeInTheDocument()
    expect(await findByText("Cache Token Usage")).toBeInTheDocument()
    expect(await findByText("Token Averages")).toBeInTheDocument()
  })

  it("renders the tool-surface filter dropdown", async () => {
    stubPerformance({
      "/api/metrics/timeseries": baseTimeseries(),
    })
    const { findByText } = renderPage(<PerformancePage />, {
      initialEntries: ["/performance"],
    })
    expect(await findByText("Tool surface")).toBeInTheDocument()
  })

  it("renders no-data state when timeseries comes back empty", async () => {
    stubPerformance({
      "/api/metrics/timeseries": { timestamps: [], series: [] },
    })
    const { findAllByText } = renderPage(<PerformancePage />, {
      initialEntries: ["/performance"],
    })
    const nodata = await findAllByText("No data available")
    expect(nodata.length).toBeGreaterThan(0)
  })
})
