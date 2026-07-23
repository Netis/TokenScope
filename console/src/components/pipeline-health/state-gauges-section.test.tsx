import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { StateGaugesSection } from "./state-gauges-section"
import type { MetricRecord } from "@/types/api"

afterEach(() => cleanup())

const PIPELINE: MetricRecord[] = [
  // capture gauges (q_ excluded — owned by Backpressure)
  { name: "flows_active", group: "capture", kind: "gauge", value: 42 },
  // protocol
  { name: "tcp_streams_active", group: "protocol", kind: "gauge", value: 12 },
  // llm
  { name: "agent_turns_open", group: "turn", kind: "gauge", value: 7 },
  // storage
  { name: "mem_rss_bytes", group: "storage", kind: "gauge", value: 1_000_000 },
  // A queue gauge — should NOT show up in this section
  { name: "q_raw_pkts", group: "capture", kind: "gauge", value: 5, capacity: 100 },
  // A counter — should NOT show up
  { name: "pkts_received", group: "capture", kind: "counter", value: 100 },
]

describe("StateGaugesSection", () => {
  it("renders the section heading and helper text", () => {
    const { container } = render(
      <StateGaugesSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    expect(container.textContent).toContain("Live Gauges")
    expect(container.textContent).toContain("Uncapped gauges")
  })

  it("renders each non-queue gauge with its value", () => {
    const { container } = render(
      <StateGaugesSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    expect(container.textContent).toContain("flows_active")
    expect(container.textContent).toContain("42")
    expect(container.textContent).toContain("tcp_streams_active")
    expect(container.textContent).toContain("12")
    expect(container.textContent).toContain("agent_turns_open")
    expect(container.textContent).toContain("7")
    expect(container.textContent).toContain("mem_rss_bytes")
    expect(container.textContent).toContain("1,000,000")
  })

  it("excludes queue gauges (q_*) and counters", () => {
    const { container } = render(
      <StateGaugesSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    expect(container.textContent).not.toContain("q_raw_pkts")
    expect(container.textContent).not.toContain("pkts_received")
  })

  it("renders the empty state when no gauges are present", () => {
    const { container } = render(
      <StateGaugesSection pipelineMetrics={[]} globalMetrics={[]} />,
    )
    expect(container.textContent).toContain("No gauges reported")
  })

  it("renders the empty state when only queue gauges are present", () => {
    const onlyQ: MetricRecord[] = [
      { name: "q_raw_pkts", group: "capture", kind: "gauge", value: 5, capacity: 100 },
    ]
    const { container } = render(
      <StateGaugesSection pipelineMetrics={onlyQ} globalMetrics={[]} />,
    )
    expect(container.textContent).toContain("No gauges reported")
  })

  it("renders the group label for each populated group", () => {
    const { container } = render(
      <StateGaugesSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    // Group labels appear upper-cased (uppercase class). Captured as text,
    // case preserved — the CSS class only changes visual rendering.
    expect(container.textContent).toContain("capture")
    expect(container.textContent).toContain("protocol")
    expect(container.textContent).toContain("turn")
    expect(container.textContent).toContain("storage")
  })

  it("merges global metrics into the gauge set", () => {
    const globals: MetricRecord[] = [
      { name: "uptime_secs", group: "metrics", kind: "gauge", value: 3600 },
    ]
    const { container } = render(
      <StateGaugesSection pipelineMetrics={PIPELINE} globalMetrics={globals} />,
    )
    expect(container.textContent).toContain("uptime_secs")
    expect(container.textContent).toContain("3,600")
  })

  it("sorts gauges within a group alphabetically by name", () => {
    const gauges: MetricRecord[] = [
      { name: "zeta_gauge", group: "capture", kind: "gauge", value: 1 },
      { name: "alpha_gauge", group: "capture", kind: "gauge", value: 2 },
      { name: "middle_gauge", group: "capture", kind: "gauge", value: 3 },
    ]
    const { container } = render(
      <StateGaugesSection pipelineMetrics={gauges} globalMetrics={[]} />,
    )
    const text = container.textContent ?? ""
    // alpha < middle < zeta in the rendered output.
    const iA = text.indexOf("alpha_gauge")
    const iM = text.indexOf("middle_gauge")
    const iZ = text.indexOf("zeta_gauge")
    expect(iA).toBeGreaterThan(-1)
    expect(iA).toBeLessThan(iM)
    expect(iM).toBeLessThan(iZ)
  })
})
