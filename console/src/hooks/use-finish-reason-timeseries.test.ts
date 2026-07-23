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
import { useFinishReasonTimeseries } from "./use-finish-reason-timeseries"

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
  return qsOf(findRequest(urls, { start, end }, "/api/metrics/finish-reasons")).get("granularity")
}

describe("useFinishReasonTimeseries", () => {
  it("hits /api/metrics/finish-reasons with window + granularity", async () => {
    const urls = captureRequests({ series: [] })
    const { result } = renderHookWithProviders(
      () => useFinishReasonTimeseries(),
      { initialEntries: ["/llm-calls"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
      granularity: "1m", // 1h (3600s) → 1m
    }, "/api/metrics/finish-reasons"))
    expect(qs.get("start")).toBe(String(NOW_S - PRESET_SECONDS["1h"]))
    expect(qs.get("end")).toBe(String(NOW_S))
    expect(qs.get("granularity")).toBe("1m")
  })

  it("includes the route-supported dimension filters", async () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: NOW_S - 100,
      end: NOW_S,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const urls = captureRequests({ series: [] })
    const { result } = renderHookWithProviders(
      () => useFinishReasonTimeseries(),
      { initialEntries: ["/llm-calls"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - 100),
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
    }, "/api/metrics/finish-reasons"))
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
  })

  const granularityCases: Array<[number, string]> = [
    [900, "10s"],
    [901, "1m"],
    [7200, "1m"],
    [7201, "5m"],
    [86400, "5m"],
    [86401, "1h"],
  ]
  for (const [span, expected] of granularityCases) {
    it(`range ${span}s → granularity ${expected}`, async () => {
      setRange(NOW_S - span, NOW_S)
      const urls = captureRequests({ series: [] })
      const { result } = renderHookWithProviders(
        () => useFinishReasonTimeseries(),
        { initialEntries: ["/llm-calls"] },
      )
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(granularityOf(urls, String(NOW_S - span), String(NOW_S))).toBe(expected)
    })
  }

  it("an explicit granularity opts out of auto-compute", async () => {
    setRange(NOW_S - 24 * 3600, NOW_S) // would auto-pick 5m
    const urls = captureRequests({ series: [] })
    const { result } = renderHookWithProviders(
      () => useFinishReasonTimeseries({ granularity: "1h" }),
      { initialEntries: ["/llm-calls"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(granularityOf(urls, String(NOW_S - 24 * 3600), String(NOW_S))).toBe("1h")
  })
})
