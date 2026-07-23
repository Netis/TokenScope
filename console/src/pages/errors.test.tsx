import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseMetricsSummary, baseModelsData, baseTimeseries, renderPage } from "../../test/fixtures"
import { ErrorsPage } from "./errors"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubErrors(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("ErrorsPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading spinner, then KPIs once summary resolves", async () => {
    stubErrors({
      "/api/metrics/summary": baseMetricsSummary({ error_count: 7, call_count: 100, error_4xx_count: 4, error_429_count: 1, error_5xx_count: 2 }),
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": baseModelsData(),
    })
    const { container, findByText } = renderPage(<ErrorsPage />, {
      initialEntries: ["/errors"],
    })
    // lucide Loader2 renders an svg while summaryLoading.
    expect(container.querySelector("svg")).toBeInTheDocument()
    // Once resolved, the "Total Errors" KPI value renders.
    expect(await findByText("Total Errors")).toBeInTheDocument()
    expect(await findByText("4xx Errors")).toBeInTheDocument()
    expect(await findByText("5xx Errors")).toBeInTheDocument()
    expect(await findByText("Error Rate")).toBeInTheDocument()
  })

  it("renders all chart section titles", async () => {
    stubErrors({
      "/api/metrics/summary": baseMetricsSummary(),
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": baseModelsData(),
    })
    const { findByText } = renderPage(<ErrorsPage />, {
      initialEntries: ["/errors"],
    })
    expect(await findByText("Error Timeline")).toBeInTheDocument()
    expect(await findByText("Error by Model")).toBeInTheDocument()
    expect(await findByText("Error Rate by Model")).toBeInTheDocument()
    expect(await findByText("429 Rate Limiting Trend")).toBeInTheDocument()
  })

  it("renders the 'No errors' state when no models have errors", async () => {
    // baseModelsData() defaults have error_count > 0; override to zero to hit
    // the ErrorByModelCountChart empty state ("No errors in selected range").
    const noErrorModels = baseModelsData({
      models: baseModelsData().models.map((m) => ({
        ...m,
        error_count: 0,
        error_4xx_count: 0,
        error_429_count: 0,
        error_5xx_count: 0,
      })),
    })
    stubErrors({
      "/api/metrics/summary": baseMetricsSummary({ error_count: 0, call_count: 100 }),
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": noErrorModels,
    })
    const { findByText } = renderPage(<ErrorsPage />, {
      initialEntries: ["/errors"],
    })
    expect(await findByText("No errors in selected range")).toBeInTheDocument()
  })
})
