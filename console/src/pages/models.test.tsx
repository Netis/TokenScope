import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { fireEvent } from "@testing-library/react"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseModelsData, baseTimeseries, renderPage } from "../../test/fixtures"
import { ModelsPage } from "./models"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubModels(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("ModelsPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the comparison table populated from the models endpoint", async () => {
    stubModels({
      "/api/metrics/models": baseModelsData(),
      "/api/metrics/timeseries": baseTimeseries(),
    })
    const { findByText } = renderPage(<ModelsPage />, {
      initialEntries: ["/models"],
    })
    // Wait for data to resolve first (the column headers are static, but
    // asserting on a row first avoids races with header re-render under
    // parallel test load).
    expect(await findByText("claude-sonnet-4")).toBeInTheDocument()
    expect(await findByText("gpt-4o")).toBeInTheDocument()
    // Column headers — match by substring (SortHeader renders an icon next
    // to the label text, so exact full-text match is brittle).
    expect(await findByText(/Wire API/)).toBeInTheDocument()
    expect(await findByText(/Generation TPS/)).toBeInTheDocument()
  })

  it("renders the empty state when no models are returned", async () => {
    stubModels({
      "/api/metrics/models": { models: [] },
      "/api/metrics/timeseries": baseTimeseries(),
    })
    const { findByText } = renderPage(<ModelsPage />, {
      initialEntries: ["/models"],
    })
    expect(await findByText("No models found in selected time range")).toBeInTheDocument()
  })

  it("reveals per-model latency/volume charts when a row is selected", async () => {
    stubModels({
      "/api/metrics/models": baseModelsData(),
      // ModelDetailCharts queries timeseries grouped by model.
      "/api/metrics/timeseries": baseTimeseries({
        series: [
          { name: "ttft_avg", group: "claude-sonnet-4", values: [300, 310, 320] },
          { name: "call_count", group: "claude-sonnet-4", values: [10, 20, 30] },
        ],
      }),
    })
    const { findByText, container } = renderPage(<ModelsPage />, {
      initialEntries: ["/models"],
    })
    // Wait for the row to render, then click the first model's <tr>.
    await findByText("claude-sonnet-4")
    const row = container.querySelector("tbody tr")
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    // The ModelDetailCharts section title renders. The em-dash sits in a
    // nested <span>, so use a substring matcher rather than exact match.
    expect(await findByText(/Latency Over Time/)).toBeInTheDocument()
    expect(await findByText(/Call Volume & Errors/)).toBeInTheDocument()
  })

  it("cycles sort order across string and numeric columns", async () => {
    stubModels({
      "/api/metrics/models": baseModelsData(),
      "/api/metrics/timeseries": baseTimeseries(),
    })
    const { findByText, getByText } = renderPage(<ModelsPage />, { initialEntries: ["/models"] })
    await findByText("claude-sonnet-4")
    // Sort by Model (string → localeCompare branch).
    fireEvent.click(getByText("Model"))
    // Toggle same key (asc/desc branch).
    fireEvent.click(getByText("Model"))
    // Switch to a numeric key (Calls).
    fireEvent.click(getByText("Calls"))
    expect(getByText("claude-sonnet-4")).toBeInTheDocument()
  })
})
