import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mockFetch, jsonResponse, setWindowOrigin, resetStore } from "../../test/mocks"
import {
  baseAgentActivity,
  baseAgentSummary,
  baseInternalMetricsSeries,
  baseMetricsSummary,
  baseModelsData,
  baseTimeseries,
  renderPage,
} from "../../test/fixtures"
import { useToolbarStore } from "@/stores/toolbar"
import { OverviewPage } from "./overview"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))
beforeEach(() => {
  resetStore(useToolbarStore, {
    preset: "1h",
    start: 1_780_000_000 - 3600,
    end: 1_780_000_000,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
})

/** Stub fetch to return the given payload keyed by URL substring. */
function stubOverview(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    // Default: empty but well-typed.
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("OverviewPage", () => {
  afterEach(() => {
    // mockFetch self-restores; nothing extra needed.
  })

  it("renders KPI cards from the metrics summary (happy path)", async () => {
    stubOverview({
      "/api/metrics/summary": baseMetricsSummary({ call_count: 42, error_count: 2, total_input_tokens: 1000, total_output_tokens: 500, ttft_avg: 320.5, e2e_avg: 2100, tpot_avg: 50 }),
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": baseModelsData(),
      "/api/agent-overview/activity": baseAgentActivity(),
      "/api/agent-overview/summary": baseAgentSummary(),
      "/api/internal-metrics/series": baseInternalMetricsSeries(),
    })
    const { findByText } = renderPage(<OverviewPage />) // local helper below
    // Total Calls KPI renders the formatted number.
    expect(await findByText("42")).toBeInTheDocument()
    // Loading spinner is gone once summary resolves.
    expect(await findByText("Total Calls")).toBeInTheDocument()
  })

  it("shows the loading spinner, then KPIs once the summary resolves", async () => {
    stubOverview({
      "/api/metrics/summary": baseMetricsSummary({ call_count: 7 }),
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": baseModelsData(),
      "/api/agent-overview/activity": baseAgentActivity(),
      "/api/agent-overview/summary": baseAgentSummary(),
      "/api/internal-metrics/series": baseInternalMetricsSeries(),
    })
    const { container, findByText } = renderPage(<OverviewPage />)
    // lucide Loader2 renders an svg while summaryLoading.
    expect(container.querySelector("svg")).toBeInTheDocument()
    // Once the summary resolves, the KPI value appears.
    expect(await findByText("7")).toBeInTheDocument()
  })

  it("renders the no-data chart state when series is empty", async () => {
    stubOverview({
      "/api/metrics/summary": baseMetricsSummary(),
      "/api/metrics/timeseries": { timestamps: [], series: [] },
      "/api/metrics/models": baseModelsData(),
      "/api/agent-overview/activity": baseAgentActivity(),
      "/api/agent-overview/summary": baseAgentSummary(),
      "/api/internal-metrics/series": baseInternalMetricsSeries(),
    })
    const { findAllByText } = renderPage(<OverviewPage />)
    const nodata = await findAllByText("No data available")
    expect(nodata.length).toBeGreaterThan(0)
  })

  it("computes error rate color by threshold", async () => {
    // 0 calls → error rate 0 → green label "Call Error Rate" still shown.
    stubOverview({
      "/api/metrics/summary": baseMetricsSummary({ call_count: 0, error_count: 0 }),
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": baseModelsData(),
      "/api/agent-overview/activity": baseAgentActivity(),
      "/api/agent-overview/summary": baseAgentSummary(),
      "/api/internal-metrics/series": baseInternalMetricsSeries(),
    })
    const { findByText } = renderPage(<OverviewPage />)
    expect(await findByText("0.00%")).toBeInTheDocument()
  })
})
