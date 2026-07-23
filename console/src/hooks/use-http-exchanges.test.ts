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
import { useHttpExchanges } from "./use-http-exchanges"

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

const baseParams = {
  page: 1,
  pageSize: 50,
  sortBy: "ts",
  sortOrder: "desc" as const,
}

describe("useHttpExchanges", () => {
  it("hits /api/http-exchanges with window + pagination + sort", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () => useHttpExchanges(baseParams),
      { initialEntries: ["/http-exchanges"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
      page: "1",
      page_size: "50",
      sort_by: "ts",
      sort_order: "desc",
    }, "/api/http-exchanges"))
    expect(qs.get("start")).toBe(String(NOW_S - PRESET_SECONDS["1h"]))
    expect(qs.get("page")).toBe("1")
    expect(qs.get("page_size")).toBe("50")
    expect(qs.get("sort_by")).toBe("ts")
    expect(qs.get("sort_order")).toBe("desc")
  })

  it("serializes the method/status/clientIp/uri filters when set", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () =>
        useHttpExchanges({
          ...baseParams,
          method: "GET,POST",
          status: "200,500",
          clientIp: "10.0.0.1",
          uri: "/v1/chat",
        }),
      { initialEntries: ["/http-exchanges"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      method: "GET,POST",
      status: "200,500",
      client_ip: "10.0.0.1",
      uri: "/v1/chat",
    }, "/api/http-exchanges"))
    expect(qs.get("method")).toBe("GET,POST")
    expect(qs.get("status")).toBe("200,500")
    expect(qs.get("client_ip")).toBe("10.0.0.1")
    expect(qs.get("uri")).toBe("/v1/chat")
  })

  it("omits empty method/status/clientIp/uri and includes only serverIp dimension", async () => {
    // /http-exchanges spec is ["serverIp"] — wireApi/model are stripped.
    resetStore(useToolbarStore, {
      preset: "custom",
      start: NOW_S - 100,
      end: NOW_S,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () => useHttpExchanges(baseParams),
      { initialEntries: ["/http-exchanges"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - 100),
      server_ip: "10.0.0.1",
      method: null,
      status: null,
      client_ip: null,
      uri: null,
      is_sse: null,
      wire_api: null,
      model: null,
    }, "/api/http-exchanges"))
    expect(qs.get("server_ip")).toBe("10.0.0.1")
    expect(qs.has("wire_api")).toBe(false)
    expect(qs.has("model")).toBe(false)
    for (const k of ["method", "status", "client_ip", "uri", "is_sse"]) {
      expect(qs.has(k)).toBe(false)
    }
  })

  it("serializes is_sse as 'true' when true (SSE only)", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () => useHttpExchanges({ ...baseParams, isSse: true }),
      { initialEntries: ["/http-exchanges"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(qsOf(findRequest(urls, { is_sse: "true" }, "/api/http-exchanges")).get("is_sse")).toBe("true")
  })

  it("serializes is_sse as 'false' when false (non-SSE only)", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () => useHttpExchanges({ ...baseParams, isSse: false }),
      { initialEntries: ["/http-exchanges"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(qsOf(findRequest(urls, { is_sse: "false" }, "/api/http-exchanges")).get("is_sse")).toBe("false")
  })

  it("omits is_sse when undefined (any)", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () => useHttpExchanges({ ...baseParams }),
      { initialEntries: ["/http-exchanges"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    findRequest(urls, { is_sse: null }, "/api/http-exchanges")
  })
})
