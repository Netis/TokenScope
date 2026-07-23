import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { baseInternalMetricsSeries } from "../../../test/fixtures"
import { ActiveGaugeChart } from "./active-gauge-chart"

afterEach(() => cleanup())

describe("ActiveGaugeChart", () => {
  it("renders the no-data state when data is undefined", () => {
    const { container } = render(
      <ActiveGaugeChart metric="flows_active" label="Flows" color="#3b82f6" data={undefined} />,
    )
    expect(container.textContent).toContain("No data available")
  })

  it("renders the no-data state when the metric has no points", () => {
    const data = {
      ts: 1,
      series: [
        { name: "other_metric", group: "capture" as const, points: [{ t: 1, v: 1 }] },
      ],
    }
    const { container } = render(
      <ActiveGaugeChart metric="flows_active" label="Flows" color="#3b82f6" data={data} />,
    )
    expect(container.textContent).toContain("No data available")
  })

  it("renders the chart frame when the metric is present", () => {
    const { container } = render(
      <ActiveGaugeChart
        metric="flows_active"
        label="Flows"
        color="#3b82f6"
        data={baseInternalMetricsSeries()}
      />,
    )
    expect(container.textContent).not.toContain("No data available")
  })

  it("renders the chart frame for the agent_turns_open metric", () => {
    const { container } = render(
      <ActiveGaugeChart
        metric="agent_turns_open"
        label="Open turns"
        color="#10b981"
        data={baseInternalMetricsSeries()}
      />,
    )
    expect(container.textContent).not.toContain("No data available")
  })

  it("respects a custom height via the empty state's style attribute", () => {
    const { container } = render(
      <ActiveGaugeChart
        metric="flows_active"
        label="Flows"
        color="#3b82f6"
        data={undefined}
        height={123}
      />,
    )
    const empty = container.querySelector("div")!
    expect(empty.getAttribute("style") ?? "").toContain("height: 123px")
  })
})
