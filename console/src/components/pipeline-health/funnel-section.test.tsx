import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { FunnelSection } from "./funnel-section"
import type { MetricRecord } from "@/types/api"

afterEach(() => cleanup())

const M: Array<MetricRecord & { capacity?: number }> = [
  // root
  { name: "pkts_received", group: "capture", kind: "counter", value: 100 },
  // dispatcher — normal upstream pkts_received
  { name: "pkts_routed", group: "capture", kind: "counter", value: 98 },
  // net — normal upstream pkts_routed (drops here to verify annotation)
  { name: "pkts_parsed", group: "protocol", kind: "counter", value: 95 },
  { name: "pkts_dropped_not_ip", group: "protocol", kind: "counter", value: 1 },
  { name: "pkts_dropped_not_tcp", group: "protocol", kind: "counter", value: 1 },
  { name: "pkts_dropped_malformed", group: "protocol", kind: "counter", value: 1 },
  // http
  { name: "http_reqs_parsed", group: "protocol", kind: "counter", value: 80 },
  { name: "http_resps_parsed", group: "protocol", kind: "counter", value: 78 },
  { name: "http_exchanges_joined", group: "protocol", kind: "counter", value: 76 },
  { name: "http_exchanges_unpaired", group: "protocol", kind: "counter", value: 1 },
  { name: "http_exchanges_expired", group: "protocol", kind: "counter", value: 1 },
  // llm
  { name: "wires_detected", group: "llm", kind: "counter", value: 40 },
  { name: "wires_ignored", group: "llm", kind: "counter", value: 30 },
  { name: "calls_with_agent", group: "llm", kind: "counter", value: 38 },
  { name: "calls_without_agent", group: "llm", kind: "counter", value: 2 },
  // turn
  { name: "calls_ingested", group: "turn", kind: "counter", value: 37 },
  { name: "calls_dropped_late", group: "turn", kind: "counter", value: 1 },
  { name: "calls_auxiliary", group: "turn", kind: "counter", value: 3 },
  { name: "turns_completed", group: "turn", kind: "counter", value: 12 },
  // metrics
  { name: "windows_emitted", group: "metrics", kind: "counter", value: 6 },
  // storage
  { name: "flushed_calls", group: "storage", kind: "counter", value: 36 },
  { name: "flushed_turns", group: "storage", kind: "counter", value: 12 },
  { name: "flushed_exchanges", group: "storage", kind: "counter", value: 76 },
  { name: "flushed_metrics", group: "storage", kind: "counter", value: 6 },
  { name: "buf_calls", group: "storage", kind: "gauge", value: 2 },
  { name: "buf_turns", group: "storage", kind: "gauge", value: 0 },
  { name: "buf_exchanges", group: "storage", kind: "gauge", value: 4 },
  { name: "buf_metrics", group: "storage", kind: "gauge", value: 1 },
]

describe("FunnelSection", () => {
  it("renders the section heading", () => {
    const { container } = render(
      <FunnelSection pipelineMetrics={M} globalMetrics={[]} />,
    )
    expect(container.textContent).toContain("Throughput Funnel")
  })

  it("renders every funnel row label with its value", () => {
    const { container } = render(
      <FunnelSection pipelineMetrics={M} globalMetrics={[]} />,
    )
    // Root
    expect(container.textContent).toContain("pkts_received")
    expect(container.textContent).toContain("100")
    // Stage 2
    expect(container.textContent).toContain("pkts_routed")
    expect(container.textContent).toContain("98")
    // Storage block
    expect(container.textContent).toContain("flushed_calls")
    expect(container.textContent).toContain("flushed_metrics")
  })

  it("renders the survival ratio caption 'of <upstream>' for normal rows", () => {
    const { container } = render(
      <FunnelSection pipelineMetrics={M} globalMetrics={[]} />,
    )
    // pkts_routed has upstream pkts_received → caption "of pkts_received"
    expect(container.textContent).toContain("of pkts_received")
    // http_resps_parsed has upstream http_reqs_parsed
    expect(container.textContent).toContain("of http_reqs_parsed")
  })

  it("renders the filter tag on filter-kind rows (wires_detected)", () => {
    const { container } = render(
      <FunnelSection pipelineMetrics={M} globalMetrics={[]} />,
    )
    expect(container.textContent).toContain("filter")
  })

  it("renders drop annotations when there is loss", () => {
    const { container } = render(
      <FunnelSection pipelineMetrics={M} globalMetrics={[]} />,
    )
    // pkts_parsed has drops (-3) → annotation includes "not_ip"
    expect(container.textContent).toContain("not_ip")
    // calls_ingested has auxiliary count → "+3 auxiliary"
    expect(container.textContent).toContain("auxiliary")
  })

  it("renders the empty funnel (no metrics) without crashing", () => {
    const { container } = render(
      <FunnelSection pipelineMetrics={[]} globalMetrics={[]} />,
    )
    // All values fall back to 0; root row still shows "pkts_received 0"
    expect(container.textContent).toContain("pkts_received")
    expect(container.textContent).toContain("0")
  })

  it("uses global metrics in addition to pipeline metrics", () => {
    const globalOnly: MetricRecord[] = [
      { name: "pkts_received", group: "capture", kind: "counter", value: 200 },
    ]
    const { container } = render(
      <FunnelSection pipelineMetrics={[]} globalMetrics={globalOnly} />,
    )
    // Root row reads pkts_received from global metrics → 200
    expect(container.textContent).toContain("200")
  })
})
