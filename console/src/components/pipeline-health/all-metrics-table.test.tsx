import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { resetStore } from "../../../test/mocks"
import { usePipelineHealthStore } from "@/stores/pipeline-health"
import { AllMetricsTable } from "./all-metrics-table"
import type { MetricRecord } from "@/types/api"

afterEach(() => {
  cleanup()
  resetStore(usePipelineHealthStore, {
    intervalMs: 2000,
    selectedPipeline: null,
    tableGroupFilter: "all",
    tableOnlyWarn: false,
  })
})

const PIPELINE: MetricRecord[] = [
  { name: "flows_active", group: "capture", kind: "gauge", value: 42 },
  { name: "agent_turns_open", group: "turn", kind: "gauge", value: 7 },
  // Gauge with capacity → ratio computed.
  { name: "q_raw_pkts", group: "capture", kind: "gauge", value: 90, capacity: 100 },
  // Counter with previous value → delta computed.
  { name: "pkts_received", group: "capture", kind: "counter", value: 100 },
  // Critical delta counter — pkts_dropped_kernel.
  { name: "pkts_dropped_kernel", group: "capture", kind: "counter", value: 3 },
  // Warning delta counter — tcp_ooo_dropped.
  { name: "tcp_ooo_dropped", group: "protocol", kind: "counter", value: 2 },
]

const GLOBAL: MetricRecord[] = [
  { name: "mem_rss_bytes", group: "storage", kind: "gauge", value: 1_000_000 },
]

const PREV: Record<string, number> = {
  pkts_received: 90,
  pkts_dropped_kernel: 0,
  tcp_ooo_dropped: 0,
}

const TS = 1_780_000_000
const PREV_TS = TS - 1000

function renderTable() {
  return render(
    <AllMetricsTable
      pipelineMetrics={PIPELINE}
      globalMetrics={GLOBAL}
      prevByName={PREV}
      ts={TS}
      prevTs={PREV_TS}
    />,
  )
}

/** Find the first button whose textContent, after stripping the
 *  trailing sort-arrow (" ↑" / " ↓"), equals `text`. Sort headers show
 *  their arrow only on the active column, so plain string equality would
 *  miss the second click. */
function findButtonByText(container: HTMLElement, text: string): HTMLElement {
  const matches = Array.from(container.querySelectorAll("button")).filter((el) => {
    const t = (el.textContent ?? "").replace(/\s[↑↓]\s*$/, "").trim()
    return t === text
  })
  if (matches.length === 0) {
    throw new Error(`no button with text "${text}"`)
  }
  return matches[0] as HTMLElement
}

describe("AllMetricsTable", () => {
  it("renders the section heading and the metric count summary", () => {
    const { container } = renderTable()
    expect(container.textContent).toContain("All Metrics")
    // Total metrics = pipeline (6) + global (1) = 7
    expect(container.textContent).toContain("7 metrics")
  })

  it("renders all metrics grouped rows with their values", () => {
    const { container } = renderTable()
    expect(container.textContent).toContain("flows_active")
    expect(container.textContent).toContain("mem_rss_bytes")
    expect(container.textContent).toContain("pkts_received")
  })

  it("computes and shows the per-second delta for counters (delta / dt-ms)", () => {
    const { container } = render(
      <AllMetricsTable
        pipelineMetrics={PIPELINE}
        globalMetrics={GLOBAL}
        prevByName={PREV}
        // dt = 1 ms → delta 10 / 1 → "10.0" per ms.
        ts={TS}
        prevTs={TS - 1}
      />,
    )
    // pkts_received: 100 - 90 = 10, dt = 1 (ms units) → 10.0 per ms.
    expect(container.textContent).toContain("+10.0")
  })

  it("shows '—' for counter delta when prevTs is null (first frame)", () => {
    const { container } = render(
      <AllMetricsTable
        pipelineMetrics={PIPELINE}
        globalMetrics={GLOBAL}
        prevByName={PREV}
        ts={TS}
        prevTs={null}
      />,
    )
    // dt = 0 → counters show em dash.
    expect(container.textContent).toContain("—")
  })

  it("computes the capacity ratio (cap%) for gauges with capacity", () => {
    const { container } = renderTable()
    // q_raw_pkts at 90/100 = 90%.
    expect(container.textContent).toContain("90%")
  })

  it("toggles onlyWarn and shows only warning rows", async () => {
    const user = userEvent.setup()
    const { container } = renderTable()
    // Initially all 7 rows visible — flows_active appears.
    expect(container.textContent).toContain("flows_active")

    // Click "⚠ only" toggle.
    await user.click(findButtonByText(container, "⚠ only"))

    // Now only the warn/critical rows are visible:
    //   pkts_dropped_kernel (critical — critical-delta counter with delta>0)
    //   q_raw_pkts (ratio 0.9 ≥ warning threshold)
    //   tcp_ooo_dropped (warning — warning-delta counter with delta>0)
    // flows_active and mem_rss_bytes (no capacity, no warn delta counter) drop out.
    expect(container.textContent).toContain("pkts_dropped_kernel")
    expect(container.textContent).toContain("q_raw_pkts")
    expect(container.textContent).toContain("tcp_ooo_dropped")
    expect(container.textContent).not.toContain("flows_active")
    expect(container.textContent).not.toContain("mem_rss_bytes")

    // Toggle back off — everything returns.
    await user.click(findButtonByText(container, "⚠ only"))
    expect(container.textContent).toContain("flows_active")
  })

  it("filters by group via the group chips", async () => {
    const user = userEvent.setup()
    const { container } = renderTable()
    // Click "storage" chip → only mem_rss_bytes shows.
    await user.click(findButtonByText(container, "storage"))
    expect(container.textContent).toContain("mem_rss_bytes")
    expect(container.textContent).not.toContain("flows_active")
    expect(container.textContent).not.toContain("pkts_received")

    // Click "all" — everything returns.
    await user.click(findButtonByText(container, "all"))
    expect(container.textContent).toContain("flows_active")
    expect(container.textContent).toContain("mem_rss_bytes")
  })

  it("sorts ascending / descending when the same sort header is clicked twice", async () => {
    const user = userEvent.setup()
    const { container } = renderTable()
    // Default sort: group asc — capture rows before protocol rows before storage.
    const iFlows = (container.textContent ?? "").indexOf("flows_active")
    const iTcp = (container.textContent ?? "").indexOf("tcp_ooo_dropped")
    const iMem = (container.textContent ?? "").indexOf("mem_rss_bytes")
    expect(iFlows).toBeLessThan(iTcp)
    expect(iTcp).toBeLessThan(iMem)

    // Click "value" header → asc by value.
    await user.click(findButtonByText(container, "value"))
    // Lowest-value row (agent_turns_open = 7) should now precede the
    // highest-value (mem_rss_bytes = 1,000,000).
    const iAgent = (container.textContent ?? "").indexOf("agent_turns_open")
    const iMem2 = (container.textContent ?? "").indexOf("mem_rss_bytes")
    expect(iAgent).toBeLessThan(iMem2)

    // Click "value" again → desc — order reverses.
    await user.click(findButtonByText(container, "value"))
    const iAgent2 = (container.textContent ?? "").indexOf("agent_turns_open")
    const iMem3 = (container.textContent ?? "").indexOf("mem_rss_bytes")
    expect(iMem3).toBeLessThan(iAgent2)
  })

  it("renders the critical-row class for a critical-delta counter with delta>0", () => {
    const { container } = renderTable()
    // The critical row gets bg-red-50.
    expect(container.querySelector(".bg-red-50")).not.toBeNull()
  })

  it("renders the warning-row class for a near-capacity gauge", () => {
    const { container } = renderTable()
    // q_raw_pkts at 0.9 → warning row (bg-amber-50).
    expect(container.querySelector(".bg-amber-50")).not.toBeNull()
  })

  it("preserves the groupFilter/onlyWarn between renders via the store", () => {
    // Set the store before rendering — AllMetricsTable reads initial state.
    resetStore(usePipelineHealthStore, {
      intervalMs: 2000,
      selectedPipeline: null,
      tableGroupFilter: "storage",
      tableOnlyWarn: false,
    })
    const { container } = render(
      <AllMetricsTable
        pipelineMetrics={PIPELINE}
        globalMetrics={GLOBAL}
        prevByName={PREV}
        ts={TS}
        prevTs={PREV_TS}
      />,
    )
    // Pre-filtered to storage — only mem_rss_bytes is shown.
    expect(container.textContent).toContain("mem_rss_bytes")
    expect(container.textContent).not.toContain("flows_active")
  })
})
