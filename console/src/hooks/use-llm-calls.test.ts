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
import { useLlmCalls } from "./use-llm-calls"

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

describe("useLlmCalls", () => {
  it("hits /api/spans with window + pagination + sort params", async () => {
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(
      () => useLlmCalls(baseParams),
      { initialEntries: ["/llm-calls"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
      page: "1",
      page_size: "50",
      sort_by: "ts",
      sort_order: "desc",
    }, "/api/spans"))
    expect(qs.get("start")).toBe(String(NOW_S - PRESET_SECONDS["1h"]))
    expect(qs.get("end")).toBe(String(NOW_S))
    expect(qs.get("page")).toBe("1")
    expect(qs.get("page_size")).toBe("50")
    expect(qs.get("sort_by")).toBe("ts")
    expect(qs.get("sort_order")).toBe("desc")
  })

  it("omits empty/undefined page-specific filters", async () => {
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(
      () => useLlmCalls(baseParams),
      { initialEntries: ["/llm-calls"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      status_code: null,
      finish_reason: null,
      client_ip: null,
      server_port: null,
      request_path: null,
      is_stream: null,
    }, "/api/spans"))
    for (const key of ["status_code", "finish_reason", "client_ip", "server_port", "request_path", "is_stream"]) {
      expect(qs.has(key)).toBe(false)
    }
  })

  it("serializes every page-specific filter when set", async () => {
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(
      () =>
        useLlmCalls({
          ...baseParams,
          statusCode: "500",
          finishReason: "stop",
          clientIp: "10.0.0.1",
          serverPort: "443,9000",
          requestPath: "/v1/chat",
          isStream: "stream",
        }),
      { initialEntries: ["/llm-calls"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      status_code: "500",
      finish_reason: "stop",
      client_ip: "10.0.0.1",
      server_port: "443,9000",
      request_path: "/v1/chat",
      is_stream: "stream",
    }, "/api/spans"))
    expect(qs.get("status_code")).toBe("500")
    expect(qs.get("finish_reason")).toBe("stop")
    expect(qs.get("client_ip")).toBe("10.0.0.1")
    expect(qs.get("server_port")).toBe("443,9000")
    expect(qs.get("request_path")).toBe("/v1/chat")
    expect(qs.get("is_stream")).toBe("stream")
  })

  it("includes the route-supported dimension filters (wireApi/model/serverIp)", async () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: NOW_S - 100,
      end: NOW_S,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(
      () => useLlmCalls(baseParams),
      { initialEntries: ["/llm-calls"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - 100),
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
    }, "/api/spans"))
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
  })
})
