import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { baseTimeseries } from "../../../test/fixtures"
import { LatencyOverviewChart } from "./latency-overview-chart"

afterEach(() => cleanup())

describe("LatencyOverviewChart", () => {
  it("renders the no-data state when data is null", () => {
    const { container } = render(<LatencyOverviewChart data={null} />)
    expect(container.textContent).toContain("No data available")
  })

  it("renders the no-data state when timestamps is empty", () => {
    const { container } = render(
      <LatencyOverviewChart data={{ timestamps: [], series: [] }} />,
    )
    expect(container.textContent).toContain("No data available")
  })

  it("renders the chart frame when data is populated", () => {
    const { container } = render(<LatencyOverviewChart data={baseTimeseries()} />)
    expect(container.textContent).not.toContain("No data available")
  })

  it("renders with a single-point series (spanSec=0 fallback)", () => {
    const single = {
      timestamps: [1_780_000_000],
      series: [{ name: "ttft_avg", group: "anthropic", values: [300] }],
    }
    const { container } = render(<LatencyOverviewChart data={single} />)
    expect(container.textContent).not.toContain("No data available")
  })
})
