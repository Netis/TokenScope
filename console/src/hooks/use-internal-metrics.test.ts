import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import {
  captureRequests,
  createTestQueryClient,
  findRequest,
  pinClock,
  qsOf,
  renderHookWithProviders,
  resetStore,
  setWindowOrigin,
} from "../../test/mocks"
import { usePipelineHealthStore } from "@/stores/pipeline-health"
import { useInternalMetrics, useInternalMetricsSeries } from "./use-internal-metrics"

const NOW_S = 1_780_000_000
let restoreClock: () => void

beforeAll(() => setWindowOrigin("http://localhost:8080/"))
beforeEach(() => (restoreClock = pinClock(NOW_S * 1000)))
afterEach(() => {
  restoreClock()
  resetStore(usePipelineHealthStore, {
    intervalMs: 2000,
    selectedPipeline: null,
    tableGroupFilter: "all",
    tableOnlyWarn: false,
  })
})

// The resolved `refetchInterval` option isn't surfaced on the query result
// object in this TanStack version; read it off the live QueryObserver instead.
function observerRefetchInterval(qcKey: ReturnType<typeof createTestQueryClient>): number | false | undefined {
  const q = qcKey.getQueryCache().getAll()[0]
  return q.observers[0]?.options.refetchInterval
}

describe("useInternalMetrics", () => {
  it("hits /api/internal-metrics (no params) and returns the data", async () => {
    const fake = { ts: 1, metrics: [] }
    const urls = captureRequests(fake)
    const { result } = renderHookWithProviders(() => useInternalMetrics())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/internal-metrics")).toBe("/api/internal-metrics")
    expect(result.current.data).toEqual(fake)
  })

  it("maps a null intervalMs (paused) to refetchInterval=false", () => {
    resetStore(usePipelineHealthStore, {
      intervalMs: null,
      selectedPipeline: null,
      tableGroupFilter: "all",
      tableOnlyWarn: false,
    })
    const qc = createTestQueryClient()
    renderHookWithProviders(() => useInternalMetrics(), { queryClient: qc })
    expect(observerRefetchInterval(qc)).toBe(false)
  })

  it("maps a numeric intervalMs to refetchInterval (ms)", () => {
    resetStore(usePipelineHealthStore, {
      intervalMs: 1234,
      selectedPipeline: null,
      tableGroupFilter: "all",
      tableOnlyWarn: false,
    })
    const qc = createTestQueryClient()
    const { unmount } = renderHookWithProviders(() => useInternalMetrics(), { queryClient: qc })
    expect(observerRefetchInterval(qc)).toBe(1234)
    // Unmount before the refetch timer fires to keep the run act-clean.
    unmount()
  })
})

describe("useInternalMetricsSeries", () => {
  it("hits the bare series URL when no since/metrics are given", async () => {
    const urls = captureRequests({ series: [] })
    const { result } = renderHookWithProviders(() => useInternalMetricsSeries())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/internal-metrics/series")).toBe("/api/internal-metrics/series")
  })

  it("appends since + metrics query params when provided", async () => {
    const urls = captureRequests({ series: [] })
    const { result } = renderHookWithProviders(() =>
      useInternalMetricsSeries({ sinceMs: 1000, metrics: ["flows_active", "turns_active"] }),
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      since: "1000",
      metrics: "flows_active,turns_active",
    }, "/api/internal-metrics/series"))
    expect(qs.get("since")).toBe("1000")
    expect(qs.get("metrics")).toBe("flows_active,turns_active")
  })

  it("omits since when <= 0, and metrics when empty", async () => {
    const urls = captureRequests({ series: [] })
    const { result } = renderHookWithProviders(() =>
      useInternalMetricsSeries({ sinceMs: 0, metrics: [] }),
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // since=0 → omitted; empty metrics → omitted → bare series URL.
    expect(findRequest(urls, { since: null, metrics: null }, "/api/internal-metrics/series"))
      .toBe("/api/internal-metrics/series")
    void result
  })

  it("defaults the poll interval to 10s", () => {
    const qc = createTestQueryClient()
    const { unmount } = renderHookWithProviders(() => useInternalMetricsSeries(), { queryClient: qc })
    expect(observerRefetchInterval(qc)).toBe(10_000)
    unmount()
  })

  it("honours an explicit intervalMs option", () => {
    const qc = createTestQueryClient()
    const { unmount } = renderHookWithProviders(() => useInternalMetricsSeries({ intervalMs: 3000 }), { queryClient: qc })
    expect(observerRefetchInterval(qc)).toBe(3000)
    unmount()
  })

  it("honours a null intervalMs (paused)", () => {
    const qc = createTestQueryClient()
    renderHookWithProviders(() => useInternalMetricsSeries({ intervalMs: null }), { queryClient: qc })
    expect(observerRefetchInterval(qc)).toBe(false)
  })
})
