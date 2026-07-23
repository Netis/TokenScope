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
import { useAgentActivity, useAgentSummary } from "./use-agent-overview"

const NOW_S = 1_780_000_000
let restoreClock: () => void

function setWindow(start: number, end: number) {
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
  setWindow(NOW_S - PRESET_SECONDS["1h"], NOW_S)
})
afterEach(() => restoreClock())

describe("useAgentSummary", () => {
  it("hits /api/traces/summary with the toolbar window", async () => {
    const urls = captureRequests()
    const { result } = renderHookWithProviders(() => useAgentSummary())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
    }, "/api/traces/summary"))
    expect(qs.get("start")).toBe(String(NOW_S - PRESET_SECONDS["1h"]))
    expect(qs.get("end")).toBe(String(NOW_S))
    void result
  })
})

describe("useAgentActivity", () => {
  it("hits /api/traces/activity with the toolbar window", async () => {
    const urls = captureRequests()
    const { result } = renderHookWithProviders(() => useAgentActivity())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
    }, "/api/traces/activity"))
    expect(qs.get("start")).toBe(String(NOW_S - PRESET_SECONDS["1h"]))
    expect(qs.get("end")).toBe(String(NOW_S))
  })
})
