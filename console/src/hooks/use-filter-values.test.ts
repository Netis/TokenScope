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
  useAgentKinds,
  useFinishReasons,
  useModelNames,
  useServerIps,
  useWireApis,
} from "./use-filter-values"

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

describe("useWireApis / useModelNames / useServerIps", () => {
  it("hits the matching filter endpoint with no params", async () => {
    const urls = captureRequests({ values: [] })
    const { result } = renderHookWithProviders(() => useWireApis())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/filters/wire-apis")).toBe("/api/filters/wire-apis")
  })

  it("useModelNames hits /api/filters/models", async () => {
    const urls = captureRequests({ values: [] })
    const { result } = renderHookWithProviders(() => useModelNames())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/filters/models")).toBe("/api/filters/models")
  })

  it("useServerIps hits /api/filters/server-ips", async () => {
    const urls = captureRequests({ values: [] })
    const { result } = renderHookWithProviders(() => useServerIps())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/filters/server-ips")).toBe("/api/filters/server-ips")
  })
})

describe("useAgentKinds", () => {
  it("hits /api/filters/agent-kinds with the toolbar window + supported dims", async () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: NOW_S - 100,
      end: NOW_S,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const urls = captureRequests({ values: [] })
    const { result } = renderHookWithProviders(
      () => useAgentKinds(),
      { initialEntries: ["/agent-turns"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - 100),
      end: String(NOW_S),
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
      include_proxy_hops: null,
    }, "/api/filters/agent-kinds"))
    expect(qs.get("start")).toBe(String(NOW_S - 100))
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
    expect(qs.has("include_proxy_hops")).toBe(false)
  })

  it("adds include_proxy_hops=true only when the flag is set", async () => {
    const urls = captureRequests({ values: [] })
    const { result } = renderHookWithProviders(
      () => useAgentKinds({ includeProxyHops: true }),
      { initialEntries: ["/agent-turns"] },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(qsOf(findRequest(urls, { include_proxy_hops: "true" }, "/api/filters/agent-kinds")).get("include_proxy_hops")).toBe("true")
  })
})

describe("useFinishReasons", () => {
  it("hits /api/filters/finish-reasons and returns pairs", async () => {
    const fake = { pairs: [{ wire_api: "anthropic", finish_reason: "end_turn" }] }
    const urls = captureRequests(fake)
    const { result } = renderHookWithProviders(() => useFinishReasons())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/filters/finish-reasons")).toBe("/api/filters/finish-reasons")
    expect(result.current.data).toEqual(fake)
  })

  it("is disabled (no fetch) when enabled:false", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: { pairs: [] } })
    })
    const { result } = renderHookWithProviders(() => useFinishReasons({ enabled: false }))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
    expect(result.current.fetchStatus).toBe("idle")
  })
})
