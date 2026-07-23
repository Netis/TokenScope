import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { ModelBreakdownChart } from "./model-breakdown-chart"
import type { MetricsModelRow } from "@/types/api"

afterEach(() => cleanup())

const ROWS: MetricsModelRow[] = [
  {
    wire_api: "anthropic",
    model: "claude-sonnet-4",
    call_count: 60,
    error_count: 0,
    error_4xx_count: 0,
    error_429_count: 0,
    error_5xx_count: 0,
    total_input_tokens: 7000,
    total_output_tokens: 5000,
    ttft_avg: 300,
    ttft_p95: 600,
    e2e_avg: 2000,
    e2e_p95: 4000,
    tpot_avg: 40,
  },
  {
    wire_api: "openai-chat",
    model: "gpt-4o",
    call_count: 40,
    error_count: 0,
    error_4xx_count: 0,
    error_429_count: 0,
    error_5xx_count: 0,
    total_input_tokens: 5000,
    total_output_tokens: 3000,
    ttft_avg: 250,
    ttft_p95: 500,
    e2e_avg: 1500,
    e2e_p95: 3000,
    tpot_avg: 50,
  },
]

describe("ModelBreakdownChart", () => {
  it("renders the no-data state when models is empty", () => {
    const { container } = render(<ModelBreakdownChart models={[]} />)
    expect(container.textContent).toContain("No data available")
  })

  it("renders the chart frame when models are populated", () => {
    const { container } = render(<ModelBreakdownChart models={ROWS} />)
    expect(container.textContent).not.toContain("No data available")
  })

  it("truncates long model names with an ellipsis in chart data", () => {
    const long: MetricsModelRow[] = [
      {
        ...ROWS[0]!,
        model: "very-long-model-name-that-exceeds-24-characters",
      },
    ]
    const { container } = render(<ModelBreakdownChart models={long} />)
    expect(container.textContent).not.toContain("No data available")
  })

  it("trims to top 10 models by call_count desc", () => {
    const many: MetricsModelRow[] = Array.from({ length: 15 }, (_, i) => ({
      wire_api: "openai-chat",
      model: `m-${i}`,
      call_count: 100 - i,
      error_count: 0,
      error_4xx_count: 0,
      error_429_count: 0,
      error_5xx_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      ttft_avg: null,
      ttft_p95: null,
      e2e_avg: null,
      e2e_p95: null,
      tpot_avg: null,
    }))
    const { container } = render(<ModelBreakdownChart models={many} />)
    expect(container.textContent).not.toContain("No data available")
  })
})
