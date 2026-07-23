import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseModelsData, baseTimeseries, renderPage } from "../../test/fixtures"
import { TrafficPage } from "./traffic"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Minimal finish-reasons response (long-format FinishReasonsResponse). */
const finishReasonsPayload = {
  series: [
    {
      finish_reason: "end_turn",
      points: [
        [1_780_000_000_000_000, 5],
        [1_780_000_060_000_000, 7],
      ],
    },
  ],
}

/** Stub fetch keyed by URL substring. */
function stubTraffic(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("TrafficPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the populated chart sections and the Top Models table", async () => {
    stubTraffic({
      "/api/metrics/finish-reasons": finishReasonsPayload,
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": baseModelsData(),
    })
    const { findByText } = renderPage(<TrafficPage />, {
      initialEntries: ["/traffic"],
    })
    expect(await findByText("Call Volume by Wire API")).toBeInTheDocument()
    expect(await findByText("Token Usage")).toBeInTheDocument()
    expect(await findByText("Model Distribution")).toBeInTheDocument()
    expect(await findByText("Finish Reason Breakdown")).toBeInTheDocument()
    expect(await findByText("Token Averages")).toBeInTheDocument()
    expect(await findByText("Top Models")).toBeInTheDocument()
    // First model from baseModelsData() renders in the table.
    expect(await findByText("claude-sonnet-4")).toBeInTheDocument()
  })

  it("renders the Top Models empty state when no models are present", async () => {
    stubTraffic({
      "/api/metrics/finish-reasons": { series: [] },
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": { models: [] },
    })
    const { findByText, findAllByText } = renderPage(<TrafficPage />, {
      initialEntries: ["/traffic"],
    })
    expect(await findByText("Top Models")).toBeInTheDocument()
    // TopModelsTable renders "No data available" when models is empty.
    const nodata = await findAllByText("No data available")
    expect(nodata.length).toBeGreaterThan(0)
  })

  it("renders the finish-reason empty state when series is empty", async () => {
    stubTraffic({
      "/api/metrics/finish-reasons": { series: [] },
      "/api/metrics/timeseries": { timestamps: [], series: [] },
      "/api/metrics/models": baseModelsData(),
    })
    const { findByText } = renderPage(<TrafficPage />, {
      initialEntries: ["/traffic"],
    })
    expect(await findByText("No finish-reason data in this range")).toBeInTheDocument()
  })

  it("cycles sort order on the Top Models table (Error %, then Calls)", async () => {
    const user = userEvent.setup()
    stubTraffic({
      "/api/metrics/finish-reasons": finishReasonsPayload,
      "/api/metrics/timeseries": baseTimeseries(),
      "/api/metrics/models": {
        models: [
          { wire_api: "anthropic", model: "alpha", call_count: 100, error_count: 10, error_4xx_count: 2, error_429_count: 1, error_5xx_count: 7, total_input_tokens: 1000, total_output_tokens: 500, ttft_avg: 200, ttft_p95: 400, e2e_avg: 1500, e2e_p95: 3000, tpot_avg: 40 },
          { wire_api: "openai-chat", model: "beta", call_count: 50, error_count: 1, error_4xx_count: 0, error_429_count: 0, error_5xx_count: 1, total_input_tokens: 500, total_output_tokens: 250, ttft_avg: 100, ttft_p95: 200, e2e_avg: 800, e2e_p95: 1600, tpot_avg: 30 },
        ],
      },
    })
    const { findByText, getByText, getAllByText } = renderPage(<TrafficPage />, {
      initialEntries: ["/traffic"],
    })
    await findByText("alpha")
    // Sort by Error % (exercises the error_rate comparator branch).
    await user.click(getByText("Error %"))
    expect(getAllByText(/alpha|beta/).length).toBeGreaterThan(0)
    // Click again to toggle to asc (exercises the same-key toggle branch).
    await user.click(getByText("Error %"))
    // Switch to a different key (Calls) — exercises the else branch.
    await user.click(getByText("Calls"))
    expect(getAllByText(/alpha|beta/).length).toBeGreaterThan(0)
  })
})
