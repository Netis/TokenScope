import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import {
  captureRequests,
  findRequest,
  pinClock,
  qsOf,
  renderHookWithProviders,
  resetStore,
  setWindowOrigin,
} from "../../test/mocks"
import { PRESET_SECONDS, useToolbarStore } from "@/stores/toolbar"
import { useMetricsSummary, useModels, useTimeseries } from "./use-metrics"

const NOW_S = 1_780_000_000
let restoreClock: () => void

function setRange(start: number, end: number) {
  resetStore(useToolbarStore, {
    preset: "custom",
    start,
    end,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
}

beforeAll(() => setWindowOrigin("http://localhost:8080/"))
beforeEach(() => {
  restoreClock = pinClock(NOW_S * 1000)
  setRange(NOW_S - PRESET_SECONDS["1h"], NOW_S)
})
afterEach(() => restoreClock())

function granularityOf(urls: string[], start: string, end: string): string | null {
  return qsOf(findRequest(urls, { start, end, fields: "ttft_p95" }, "/api/metrics/timeseries")).get("granularity")
}

describe("useMetricsSummary", () => {
  it("hits /api/metrics/summary with window + supported dims", async () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: NOW_S - 100,
      end: NOW_S,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const urls = captureRequests()
    const { result } = renderHookWithProviders(
      () => useMetricsSummary(),
      { initialEntries: ["/performance"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - 100),
      end: String(NOW_S),
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
    }, "/api/metrics/summary"))
    expect(qs.get("start")).toBe(String(NOW_S - 100))
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
  })
})

describe("useModels", () => {
  it("hits /api/metrics/models with window + supported dims", async () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: NOW_S - 100,
      end: NOW_S,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const urls = captureRequests()
    const { result } = renderHookWithProviders(
      () => useModels(),
      { initialEntries: ["/models"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - 100),
      end: String(NOW_S),
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
    }, "/api/metrics/models"))
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
  })
})

describe("useTimeseries — granularity auto-compute", () => {
  // Buckets: ≤900s → 10s, ≤7200s → 1m, ≤86400s → 5m, else 1h.
  const cases: Array<[number, string]> = [
    [15 * 60, "10s"], // 900s
    [900, "10s"], // exactly 900s boundary
    [901, "1m"], // just over → 1m
    [2 * 3600, "1m"], // 7200s
    [7200, "1m"], // exactly 7200s
    [7201, "5m"], // just over → 5m
    [24 * 3600, "5m"], // 86400s
    [86401, "1h"], // over a day → 1h
    [7 * 24 * 3600, "1h"], // 7d
  ]

  for (const [spanSec, expected] of cases) {
    it(`range ${spanSec}s → granularity ${expected}`, async () => {
      setRange(NOW_S - spanSec, NOW_S)
      const urls = captureRequests()
      const { result } = renderHookWithProviders(
        () => useTimeseries("ttft_p95"),
        { initialEntries: ["/performance"] },
      )
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(granularityOf(urls, String(NOW_S - spanSec), String(NOW_S))).toBe(expected)
    })
  }

  it("an explicit granularity opts out of auto-compute", async () => {
    setRange(NOW_S - 24 * 3600, NOW_S) // would auto-pick 5m
    const urls = captureRequests()
    const { result } = renderHookWithProviders(
      () => useTimeseries("ttft_p95", { granularity: "30s" }),
      { initialEntries: ["/performance"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(granularityOf(urls, String(NOW_S - 24 * 3600), String(NOW_S))).toBe("30s")
  })

  it("sends fields + group_by + tool_surface", async () => {
    const urls = captureRequests()
    const { result } = renderHookWithProviders(
      () => useTimeseries("ttft_p95,e2e", { groupBy: "model", toolSurface: "mcp" }),
      { initialEntries: ["/performance"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      fields: "ttft_p95,e2e",
      group_by: "model",
      tool_surface: "mcp",
    }, "/api/metrics/timeseries"))
    expect(qs.get("fields")).toBe("ttft_p95,e2e")
    expect(qs.get("group_by")).toBe("model")
    expect(qs.get("tool_surface")).toBe("mcp")
  })

  it("omits tool_surface when the option is an empty string", async () => {
    const urls = captureRequests()
    const { result } = renderHookWithProviders(
      () => useTimeseries("ttft_p95", { toolSurface: "" }),
      { initialEntries: ["/performance"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    findRequest(urls, { fields: "ttft_p95", tool_surface: null }, "/api/metrics/timeseries")
  })
})
