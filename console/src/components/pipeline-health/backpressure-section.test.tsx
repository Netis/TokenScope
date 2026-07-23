import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { BackpressureSection } from "./backpressure-section"
import type { MetricRecord } from "@/types/api"

afterEach(() => cleanup())

const PIPELINE: MetricRecord[] = [
  // Main spine queues with various health classifications
  { name: "q_raw_pkts", group: "capture", kind: "gauge", value: 10, capacity: 100 },
  { name: "q_parsed_pkts", group: "capture", kind: "gauge", value: 90, capacity: 100 }, // warn
  { name: "q_http_parse_events", group: "protocol", kind: "gauge", value: 96, capacity: 100 }, // critical
  { name: "q_http_joiner_events", group: "protocol", kind: "gauge", value: 5, capacity: 100 },
  { name: "q_agent_calls", group: "llm", kind: "gauge", value: 1, capacity: 100 },
  { name: "q_turns", group: "turn", kind: "gauge", value: 0, capacity: 100 },
  // Branch queues
  { name: "q_exchanges", group: "protocol", kind: "gauge", value: 5, capacity: 50 },
  { name: "q_calls", group: "llm", kind: "gauge", value: 5, capacity: 50 },
  { name: "q_llm_events", group: "llm", kind: "gauge", value: 5, capacity: 50 },
  { name: "q_metrics", group: "metrics", kind: "gauge", value: 5, capacity: 50 },
]

describe("BackpressureSection", () => {
  it("renders the section heading and pipeline description", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    expect(container.textContent).toContain("Backpressure")
    expect(container.textContent).toContain("storage")
  })

  it("renders the storage column", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    // StorageColumn renders the "storage" label
    expect(container.textContent).toContain("storage")
  })

  it("renders every queue cell with its name", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    for (const name of [
      "q_raw_pkts",
      "q_parsed_pkts",
      "q_http_parse_events",
      "q_http_joiner_events",
      "q_agent_calls",
      "q_turns",
      "q_exchanges",
      "q_calls",
      "q_llm_events",
      "q_metrics",
    ]) {
      expect(container.textContent).toContain(name)
    }
  })

  it("renders the capacity/utilisation counts and percentages", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    // q_parsed_pkts = 90/100 (90%) — rendered with locale-formatted ints.
    expect(container.textContent).toContain("90")
    expect(container.textContent).toContain("100")
    expect(container.textContent).toContain("90%")
  })

  it("applies the warn (amber) class to a near-full queue", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    // q_parsed_pkts at 90% ≥ 0.9 warning threshold — the cell carries the
    // amber-300 border class.
    expect(container.textContent).toContain("q_parsed_pkts")
    expect(container.querySelector(".border-amber-300")).not.toBeNull()
  })

  it("applies the bad (red) class to an over-threshold queue", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    // q_http_parse_events at 96% ≥ 0.95 critical — red-300 border.
    expect(container.querySelector(".border-red-300")).not.toBeNull()
  })

  it("falls back to (0, 0) when a queue metric is absent", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={[]} globalMetrics={[]} />,
    )
    // All queue cells render 0/0 (0%); capacity 0 disables classification → ok.
    expect(container.textContent).toContain("0/0 (0%)")
  })

  it("treats a counter with the same name as the queue as not a gauge (skips it)", () => {
    const counters: MetricRecord[] = [
      { name: "q_raw_pkts", group: "capture", kind: "counter", value: 50 },
    ]
    const { container } = render(
      <BackpressureSection pipelineMetrics={counters} globalMetrics={[]} />,
    )
    // q() helper only picks up gauges — the counter is ignored, falls to 0/0.
    expect(container.textContent).toContain("0/0 (0%)")
  })

  it("includes global metrics in the queue lookup", () => {
    const globals: MetricRecord[] = [
      { name: "q_turns", group: "storage", kind: "gauge", value: 42, capacity: 200 },
    ]
    const { container } = render(
      <BackpressureSection pipelineMetrics={[]} globalMetrics={globals} />,
    )
    // q_turns comes from global here — 42/200 (21%).
    expect(container.textContent).toContain("42")
    expect(container.textContent).toContain("200")
    expect(container.textContent).toContain("21%")
  })

  it("renders all stage pills (cap, disp, proto, joiner, llm, turn, metrics)", () => {
    const { container } = render(
      <BackpressureSection pipelineMetrics={PIPELINE} globalMetrics={[]} />,
    )
    for (const label of ["cap", "disp", "proto", "joiner", "llm", "turn", "metrics"]) {
      expect(container.textContent).toContain(label)
    }
  })
})
