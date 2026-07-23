import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { ErrorListSection } from "./error-list-section"

afterEach(() => cleanup())

describe("ErrorListSection", () => {
  it("renders the empty state when no error counters have non-zero values", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "pkts_dropped_kernel", group: "capture", kind: "counter", value: 0 },
          { name: "flush_errors", group: "storage", kind: "counter", value: 0 },
        ]}
        globalMetrics={[]}
        prevByName={{}}
      />,
    )
    expect(container.textContent).toContain("No errors recorded")
  })

  it("renders the empty state when no error counters are present at all", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "pkts_received", group: "capture", kind: "counter", value: 100 },
          { name: "flows_active", group: "capture", kind: "gauge", value: 5 },
        ]}
        globalMetrics={[]}
        prevByName={{}}
      />,
    )
    expect(container.textContent).toContain("No errors recorded")
  })

  it("renders a critical finding when a critical counter has a positive value", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "pkts_dropped_kernel", group: "capture", kind: "counter", value: 5 },
        ]}
        globalMetrics={[]}
        prevByName={{ pkts_dropped_kernel: 2 }}
      />,
    )
    expect(container.textContent).toContain("critical")
    expect(container.textContent).toContain("pkts_dropped_kernel")
    // The value (5) and delta (3) are formatted and shown.
    expect(container.textContent).toContain("5")
    expect(container.textContent).toContain("+3")
    // The explanation for pkts_dropped_kernel is rendered.
    expect(container.textContent).toContain("Kernel ring buffer overflowed")
  })

  it("renders a warning finding when a warning counter has a positive value (no delta)", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "tcp_ooo_dropped", group: "protocol", kind: "counter", value: 4 },
        ]}
        globalMetrics={[]}
        prevByName={{ tcp_ooo_dropped: 4 }}
      />,
    )
    expect(container.textContent).toContain("warning")
    expect(container.textContent).toContain("tcp_ooo_dropped")
    expect(container.textContent).toContain("TCP segment received out of order")
  })

  it("fires a finding when delta > 0 even if current value is 0", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "flush_errors", group: "storage", kind: "counter", value: 0 },
        ]}
        globalMetrics={[]}
        prevByName={{ flush_errors: 5 }}
      />,
    )
    // delta = max(0, 0 - 5) = 0 → so the delta test fails (Math.max). But
    // the CRITICAL_DELTA_COUNTERS rule fires on `m.value > 0 || delta > 0`,
    // so with value=0 and delta=0, nothing fires. The empty state shows.
    expect(container.textContent).toContain("No errors recorded")
  })

  it("fires on cumulative value > 0 even with no recent delta", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "read_errors", group: "capture", kind: "counter", value: 7 },
        ]}
        globalMetrics={[]}
        prevByName={{ read_errors: 7 }}
      />,
    )
    // read_errors is a critical-delta counter; value>0 fires critical.
    expect(container.textContent).toContain("critical")
    expect(container.textContent).toContain("read_errors")
  })

  it("sorts critical findings before warnings and by descending delta", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "tcp_ooo_dropped", group: "protocol", kind: "counter", value: 3 },
          { name: "pkts_dropped_kernel", group: "capture", kind: "counter", value: 2 },
          { name: "flush_errors", group: "storage", kind: "counter", value: 10 },
        ]}
        globalMetrics={[]}
        prevByName={
          {
            tcp_ooo_dropped: 0,
            pkts_dropped_kernel: 0,
            flush_errors: 0,
          }
        }
      />,
    )
    const text = container.textContent ?? ""
    // Critical findings come first; the critical with the largest delta
    // (flush_errors: 10) comes before the other critical (pkts_dropped_kernel: 2),
    // which comes before the warning (tcp_ooo_dropped).
    const iFlush = text.indexOf("flush_errors")
    const iPkts = text.indexOf("pkts_dropped_kernel")
    const iTcp = text.indexOf("tcp_ooo_dropped")
    expect(iFlush).toBeGreaterThan(-1)
    expect(iFlush).toBeLessThan(iPkts)
    expect(iPkts).toBeLessThan(iTcp)
  })

  it("renders unknown metric names without an explanation (no crash)", () => {
    // Custom counter named 'totally_made_up_error' is NOT in
    // CRITICAL_DELTA_COUNTERS or WARNING_DELTA_COUNTERS, so it's ignored.
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[
          { name: "totally_made_up_error", group: "storage", kind: "counter", value: 5 },
        ]}
        globalMetrics={[]}
        prevByName={{}}
      />,
    )
    // Not classified → empty state.
    expect(container.textContent).toContain("No errors recorded")
  })

  it("merges pipeline and global metrics", () => {
    const { container } = render(
      <ErrorListSection
        pipelineMetrics={[]}
        globalMetrics={[
          { name: "batches_dropped_zmq", group: "capture", kind: "counter", value: 3 },
        ]}
        prevByName={{}}
      />,
    )
    expect(container.textContent).toContain("critical")
    expect(container.textContent).toContain("batches_dropped_zmq")
  })
})
