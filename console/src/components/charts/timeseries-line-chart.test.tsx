import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { baseTimeseries } from "../../../test/fixtures"
import { TimeseriesLineChart } from "./timeseries-line-chart"
import { formatNumber } from "@/lib/format"

afterEach(() => cleanup())

const SERIES = [
  { key: "ttft_avg", label: "TTFT avg", color: "#f59e0b" },
  { key: "e2e_avg", label: "E2E avg", color: "#3b82f6" },
]

describe("TimeseriesLineChart", () => {
  it("renders the no-data state when data is null", () => {
    const { container } = render(
      <TimeseriesLineChart data={null} series={SERIES} yFormatter={formatNumber} />,
    )
    expect(container.textContent).toContain("No data available")
  })

  it("renders the no-data state when timestamps is empty", () => {
    const { container } = render(
      <TimeseriesLineChart
        data={{ timestamps: [], series: [] }}
        series={SERIES}
        yFormatter={formatNumber}
      />,
    )
    expect(container.textContent).toContain("No data available")
  })

  it("renders the chart frame when data is populated (line variant)", () => {
    const { container } = render(
      <TimeseriesLineChart data={baseTimeseries()} series={SERIES} yFormatter={formatNumber} />,
    )
    expect(container.textContent).not.toContain("No data available")
  })

  it("renders the chart frame with the area variant", () => {
    const { container } = render(
      <TimeseriesLineChart
        data={baseTimeseries()}
        series={SERIES}
        yFormatter={formatNumber}
        variant="area"
      />,
    )
    expect(container.textContent).not.toContain("No data available")
  })

  it("applies the configured height via the empty state's style attribute", () => {
    const { container } = render(
      <TimeseriesLineChart
        data={null}
        series={SERIES}
        yFormatter={formatNumber}
        height={321}
      />,
    )
    const empty = container.querySelector("div")!
    expect(empty.getAttribute("style") ?? "").toContain("height: 321px")
  })

  it("renders series with a dash config without crashing", () => {
    const dashed = [{ ...SERIES[0]!, dash: "5 3" }]
    const { container } = render(
      <TimeseriesLineChart
        data={baseTimeseries()}
        series={dashed}
        yFormatter={formatNumber}
      />,
    )
    expect(container.textContent).not.toContain("No data available")
  })
})
