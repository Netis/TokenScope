import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { baseTimeseries } from "../../../test/fixtures"
import { StackedBarChart } from "./stacked-bar-chart"

afterEach(() => cleanup())

describe("StackedBarChart", () => {
  it("renders the no-data state when data is null", () => {
    const { container } = render(<StackedBarChart data={null} field="call_count" />)
    expect(container.textContent).toContain("No data available")
  })

  it("renders the no-data state when timestamps is empty", () => {
    const { container } = render(
      <StackedBarChart
        data={{ timestamps: [], series: [] }}
        field="call_count"
      />,
    )
    expect(container.textContent).toContain("No data available")
  })

  it("does NOT render the no-data state when data is populated", () => {
    // baseTimeseries() has two call_count groups: anthropic + openai-chat
    const { container } = render(
      <StackedBarChart data={baseTimeseries()} field="call_count" />,
    )
    expect(container.textContent).not.toContain("No data available")
    // recharts' ResponsiveContainer renders a div wrapper even under
    // happy-dom (where it can't measure layout). The chart surface
    // exists even if the inner SVG doesn't paint.
    expect(container.firstChild).not.toBeNull()
  })

  it("renders with a custom yFormatter without crashing", () => {
    const { container } = render(
      <StackedBarChart
        data={baseTimeseries()}
        field="call_count"
        yFormatter={(v) => `${v}!`}
      />,
    )
    expect(container.textContent).not.toContain("No data available")
  })

  it("renders the chart frame even when the field has no matching series", () => {
    // baseTimeseries series all use name="call_count"; a different field
    // has no matching groups → still renders the chart frame (empty bars).
    const { container } = render(
      <StackedBarChart data={baseTimeseries()} field="other_field" />,
    )
    expect(container.textContent).not.toContain("No data available")
  })

  it("respects a custom height via the empty state's style attribute", () => {
    const { container } = render(
      <StackedBarChart data={null} field="call_count" height={123} />,
    )
    const empty = container.querySelector("div")!
    expect(empty.getAttribute("style") ?? "").toContain("height: 123px")
  })
})
