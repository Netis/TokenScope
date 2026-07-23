import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { baseTimeseries } from "../../../test/fixtures"
import { RequestVolumeChart } from "./request-volume-chart"

afterEach(() => cleanup())

describe("RequestVolumeChart", () => {
  it("renders the no-data state when data is null", () => {
    const { container } = render(<RequestVolumeChart data={null} />)
    expect(container.textContent).toContain("No data available")
  })

  it("renders the no-data state when timestamps is empty", () => {
    const { container } = render(
      <RequestVolumeChart data={{ timestamps: [], series: [] }} />,
    )
    expect(container.textContent).toContain("No data available")
  })

  it("renders the chart frame when data is populated", () => {
    // baseTimeseries() series name "call_count" with groups — picked up
    // by the chart.
    const { container } = render(<RequestVolumeChart data={baseTimeseries()} />)
    expect(container.textContent).not.toContain("No data available")
  })

  it("renders the chart frame when only non-call_count series exist", () => {
    const other: typeof baseTimeseries = () => ({
      timestamps: [1, 2, 3],
      series: [
        { name: "tokens_in", group: "anthropic", values: [10, 20, 30] },
      ],
    })
    const { container } = render(<RequestVolumeChart data={other()} />)
    // No call_count series → no groups → still renders the chart frame.
    expect(container.textContent).not.toContain("No data available")
  })
})
