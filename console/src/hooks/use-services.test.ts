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
import { useServices } from "./use-services"

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

// Capture every fetch URL the hook makes into an array; assert on the request
// whose params identify THIS test (via findRequest) so a stray refetch from
// another query under parallel contention can't masquerade as this one.
describe("useServices", () => {
  it("hits /api/services with the toolbar window + sort/limit params", async () => {
    const urls = captureRequests({ services: [] })
    const { result } = renderHookWithProviders(() =>
      useServices({ sortBy: "call_count", sortOrder: "desc", limit: 50 }),
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
      sort_by: "call_count",
      sort_order: "desc",
      limit: "50",
    }))
    expect(qs.get("start")).toBe(String(NOW_S - PRESET_SECONDS["1h"]))
    expect(qs.get("end")).toBe(String(NOW_S))
    expect(qs.get("sort_by")).toBe("call_count")
    expect(qs.get("sort_order")).toBe("desc")
    expect(qs.get("limit")).toBe("50")
    expect(result.current.data).toEqual({ services: [] })
  })

  it("defaults sortBy=call_count, sortOrder=desc, limit=200 when omitted", async () => {
    const urls = captureRequests({ services: [] })
    const { result } = renderHookWithProviders(() => useServices())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
      sort_by: "call_count",
      sort_order: "desc",
      limit: "200",
    }))
    expect(qs.get("sort_by")).toBe("call_count")
    expect(qs.get("sort_order")).toBe("desc")
    expect(qs.get("limit")).toBe("200")
    void result
  })

  it("honours a custom toolbar window for the request", async () => {
    setWindow(1000, 2000)
    const urls = captureRequests({ services: [] })
    const { result } = renderHookWithProviders(() => useServices())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, { start: "1000", end: "2000" }))
    expect(qs.get("start")).toBe("1000")
    expect(qs.get("end")).toBe("2000")
  })
})
