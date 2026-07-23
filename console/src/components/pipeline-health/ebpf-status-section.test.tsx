import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import * as React from "react"
import {
  createTestQueryClient,
  setQueryData,
  setWindowOrigin,
} from "../../../test/mocks"
import { baseRuntimeConfig } from "../../../test/fixtures"
import { EbpfStatusSection } from "./ebpf-status-section"
import type { MetricRecord } from "@/types/api"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))
afterEach(() => cleanup())

const EBPF_METRICS: MetricRecord[] = [
  { name: "ebpf_uprobes_attached", group: "ebpf", kind: "gauge", value: 2 },
  { name: "ebpf_events_received", group: "ebpf", kind: "counter", value: 1234 },
  { name: "ebpf_events_dropped", group: "ebpf", kind: "counter", value: 5 },
  { name: "ebpf_bytes_captured", group: "ebpf", kind: "counter", value: 99_999 },
  { name: "ebpf_frames_synthesized", group: "ebpf", kind: "counter", value: 87 },
  { name: "ebpf_connections_active", group: "ebpf", kind: "gauge", value: 3 },
  { name: "ebpf_process_cache_size", group: "ebpf", kind: "gauge", value: 11 },
]

function renderWith(
  config: ReturnType<typeof baseRuntimeConfig>,
  metrics: MetricRecord[] = EBPF_METRICS,
  prevByName: Record<string, number> = {},
) {
  const qc = createTestQueryClient()
  setQueryData(qc, ["runtime-config"], config)
  const ui = <EbpfStatusSection pipelineMetrics={metrics} prevByName={prevByName} />
  return render(ui, {
    wrapper: ({ children }) =>
      React.createElement(QueryClientProvider, { client: qc }, children),
  })
}

describe("EbpfStatusSection", () => {
  it("renders the 'Unavailable' tone when ebpf_available is false", () => {
    // baseRuntimeConfig defaults ebpf_available=false
    const { container } = renderWith(baseRuntimeConfig())
    expect(container.textContent).toContain("Unavailable")
    expect(container.textContent).toContain("built without the `ebpf` feature")
    // Tile grid is hidden when unavailable
    expect(container.textContent).not.toContain("events received")
  })

  it("renders the 'No uprobes attached' warn tone when ebpf available but 0 uprobes", () => {
    const noUprobes: MetricRecord[] = [
      { name: "ebpf_uprobes_attached", group: "ebpf", kind: "gauge", value: 0 },
      { name: "ebpf_events_received", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_events_dropped", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_bytes_captured", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_frames_synthesized", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_connections_active", group: "ebpf", kind: "gauge", value: 0 },
      { name: "ebpf_process_cache_size", group: "ebpf", kind: "gauge", value: 0 },
    ]
    const { container } = renderWith(
      baseRuntimeConfig({ ebpf_available: true }),
      noUprobes,
    )
    expect(container.textContent).toContain("No uprobes attached")
    expect(container.textContent).toContain("CAP_BPF")
  })

  it("renders the 'Capturing' live tone when events advanced since the previous frame", () => {
    const { container } = renderWith(
      baseRuntimeConfig({ ebpf_available: true }),
      EBPF_METRICS,
      // prev < current → capturingNow === true
      { ebpf_events_received: 100 },
    )
    expect(container.textContent).toContain("Capturing")
    // Live tone shows the uprobe count suffix in the header.
    expect(container.textContent).toContain("2 uprobe")
    // Tiles visible when available.
    expect(container.textContent).toContain("events received")
    expect(container.textContent).toContain("bytes captured")
    expect(container.textContent).toContain("frames synth")
    expect(container.textContent).toContain("active conns")
    expect(container.textContent).toContain("process cache")
    expect(container.textContent).toContain("events dropped")
    // Dropped > 0 → warn tile class kicks in; tile is still rendered with the value.
    expect(container.textContent).toContain("5")
  })

  it("renders the 'Attached · idle' tone when events > 0 but no traffic since last frame", () => {
    const { container } = renderWith(
      baseRuntimeConfig({ ebpf_available: true }),
      EBPF_METRICS,
      // prev === current → capturingNow === false; events > 0 → idle
      { ebpf_events_received: 1234 },
    )
    expect(container.textContent).toContain("Attached · idle")
    expect(container.textContent).toContain("1,234 SSL events captured")
  })

  it("renders the 'Attached · waiting' tone when uprobes are set but no events yet", () => {
    const waitingMetrics: MetricRecord[] = [
      { name: "ebpf_uprobes_attached", group: "ebpf", kind: "gauge", value: 1 },
      { name: "ebpf_events_received", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_events_dropped", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_bytes_captured", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_frames_synthesized", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_connections_active", group: "ebpf", kind: "gauge", value: 0 },
      { name: "ebpf_process_cache_size", group: "ebpf", kind: "gauge", value: 0 },
    ]
    const { container } = renderWith(
      baseRuntimeConfig({ ebpf_available: true }),
      waitingMetrics,
    )
    expect(container.textContent).toContain("Attached · waiting")
    expect(container.textContent).toContain("openssl s_client")
  })

  it("uses 0 as the previous-event value when prevByName omits ebpf_events_received", () => {
    const capturingFromZero: MetricRecord[] = [
      { name: "ebpf_uprobes_attached", group: "ebpf", kind: "gauge", value: 1 },
      { name: "ebpf_events_received", group: "ebpf", kind: "counter", value: 10 },
      { name: "ebpf_events_dropped", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_bytes_captured", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_frames_synthesized", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_connections_active", group: "ebpf", kind: "gauge", value: 0 },
      { name: "ebpf_process_cache_size", group: "ebpf", kind: "gauge", value: 0 },
    ]
    // No prev entry — component defaults prevEvents to current (10),
    // so capturingNow === false → events>0 → idle.
    const { container } = renderWith(
      baseRuntimeConfig({ ebpf_available: true }),
      capturingFromZero,
      {},
    )
    expect(container.textContent).toContain("Attached · idle")
  })

  it("shows the singular '1 uprobe' form when exactly one uprobe is attached", () => {
    const oneUprobe: MetricRecord[] = [
      { name: "ebpf_uprobes_attached", group: "ebpf", kind: "gauge", value: 1 },
      { name: "ebpf_events_received", group: "ebpf", kind: "counter", value: 50 },
      { name: "ebpf_events_dropped", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_bytes_captured", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_frames_synthesized", group: "ebpf", kind: "counter", value: 0 },
      { name: "ebpf_connections_active", group: "ebpf", kind: "gauge", value: 0 },
      { name: "ebpf_process_cache_size", group: "ebpf", kind: "gauge", value: 0 },
    ]
    const { container } = renderWith(
      baseRuntimeConfig({ ebpf_available: true }),
      oneUprobe,
      { ebpf_events_received: 10 },
    )
    expect(container.textContent).toContain("1 uprobe")
    expect(container.textContent).not.toContain("1 uprobe s")
  })
})
