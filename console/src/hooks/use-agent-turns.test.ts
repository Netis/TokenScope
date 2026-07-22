import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import {
  captureRequests,
  findRequest,
  jsonResponse,
  mockFetch,
  pinClock,
  qsOf,
  renderHookWithProviders,
  resetStore,
  setWindowOrigin,
} from "../../test/mocks"
import { PRESET_SECONDS, useToolbarStore } from "@/stores/toolbar"
import {
  useAgentTurnCalls,
  useAgentTurnDetail,
  useAgentTurnProxyView,
  useAgentTurns,
} from "./use-agent-turns"

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
  page: 2,
  pageSize: 25,
  sortBy: "ts",
  sortOrder: "asc" as const,
}

describe("useAgentTurns", () => {
  it("hits /api/traces with window + pagination + sort", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () => useAgentTurns(baseParams),
      { initialEntries: ["/agent-turns"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
      page: "2",
      page_size: "25",
      sort_by: "ts",
      sort_order: "asc",
    }, "/api/traces"))
    // /api/traces is a prefix of /api/traces/:id; the list fetch carries
    // page/page_size so findRequest's full match picks it over a detail fetch.
    expect(qs.get("start")).toBe(String(NOW_S - PRESET_SECONDS["1h"]))
    expect(qs.get("page")).toBe("2")
    expect(qs.get("page_size")).toBe("25")
    expect(qs.get("sort_by")).toBe("ts")
    expect(qs.get("sort_order")).toBe("asc")
  })

  it("serializes every CSV/flag filter when set, including include_proxy_hops", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () =>
        useAgentTurns({
          ...baseParams,
          status: "success,error",
          agentKind: "claude-cli,codex-cli",
          clientIp: "10.0.0.1,10.0.0.2",
          serverPort: "4210,9000",
          includeProxyHops: true,
        }),
      { initialEntries: ["/agent-turns"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      status: "success,error",
      agent_kind: "claude-cli,codex-cli",
      client_ip: "10.0.0.1,10.0.0.2",
      server_port: "4210,9000",
      include_proxy_hops: "true",
    }, "/api/traces"))
    expect(qs.get("status")).toBe("success,error")
    expect(qs.get("agent_kind")).toBe("claude-cli,codex-cli")
    expect(qs.get("client_ip")).toBe("10.0.0.1,10.0.0.2")
    expect(qs.get("server_port")).toBe("4210,9000")
    expect(qs.get("include_proxy_hops")).toBe("true")
  })

  it("omits empty CSV filters and keeps include_proxy_hops off when false", async () => {
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () =>
        useAgentTurns({
          ...baseParams,
          status: "",
          agentKind: "",
          clientIp: "",
          serverPort: "",
          includeProxyHops: false,
        }),
      { initialEntries: ["/agent-turns"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      status: null,
      agent_kind: null,
      client_ip: null,
      server_port: null,
      include_proxy_hops: null,
    }, "/api/traces"))
    for (const k of ["status", "agent_kind", "client_ip", "server_port", "include_proxy_hops"]) {
      expect(qs.has(k)).toBe(false)
    }
  })

  it("includes the route-supported dimension filters", async () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: NOW_S - 100,
      end: NOW_S,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const urls = captureRequests({ items: [], page: 1, total: 0 })
    const { result } = renderHookWithProviders(
      () => useAgentTurns(baseParams),
      { initialEntries: ["/agent-turns"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - 100),
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
    }, "/api/traces"))
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
  })
})

describe("useAgentTurnDetail", () => {
  it("is disabled when id is null", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { result } = renderHookWithProviders(() => useAgentTurnDetail(null))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
    expect(result.current.fetchStatus).toBe("idle")
  })

  it("hits /api/traces/:id when id is set", async () => {
    const urls = captureRequests({ id: "t1" })
    const { result } = renderHookWithProviders(() => useAgentTurnDetail("t1"))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/traces/t1")).toBe("/api/traces/t1")
  })
})

describe("useAgentTurnCalls", () => {
  it("hits /api/traces/:id/spans with no query when lite is false", async () => {
    const urls = captureRequests([])
    const { result } = renderHookWithProviders(() => useAgentTurnCalls("t1", false))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, { lite: null }, "/api/traces/t1/spans")).toBe("/api/traces/t1/spans")
  })

  it("adds lite=1 when lite is true (heavy-field NULLing)", async () => {
    const urls = captureRequests([])
    const { result } = renderHookWithProviders(() => useAgentTurnCalls("t1", true))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, { lite: "1" }, "/api/traces/t1/spans"))
    expect(qs.get("lite")).toBe("1")
  })

  it("is disabled when id is null", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: [] })
    })
    renderHookWithProviders(() => useAgentTurnCalls(null))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
  })
})

describe("useAgentTurnProxyView", () => {
  it("is disabled when id is null (regardless of enabled)", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    renderHookWithProviders(() => useAgentTurnProxyView(null, true))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
  })

  it("is disabled when enabled is false even with an id", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    renderHookWithProviders(() => useAgentTurnProxyView("t1", false))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
  })

  it("hits /api/traces/:id/proxy-view when enabled with an id", async () => {
    const urls = captureRequests({ legs: [] })
    const { result } = renderHookWithProviders(() => useAgentTurnProxyView("t1", true))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/traces/t1/proxy-view")).toBe("/api/traces/t1/proxy-view")
  })
})
