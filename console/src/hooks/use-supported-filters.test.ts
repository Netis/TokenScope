import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { pinClock, renderHookWithProviders, resetStore, setWindowOrigin } from "../../test/mocks"
import { PRESET_SECONDS, useToolbarStore } from "@/stores/toolbar"
import { useSupportedFilterParams } from "./use-supported-filters"

const NOW_S = 1_780_000_000
let restoreClock: () => void

beforeAll(() => setWindowOrigin("http://localhost:8080/"))
beforeEach(() => {
  restoreClock = pinClock(NOW_S * 1000)
  resetStore(useToolbarStore, {
    preset: "custom",
    start: NOW_S - PRESET_SECONDS["1h"],
    end: NOW_S,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
})
afterEach(() => restoreClock())

describe("useSupportedFilterParams", () => {
  it("returns the full spec + all non-empty filters for /llm-calls", () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: 0,
      end: 1,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const { result } = renderHookWithProviders(() => useSupportedFilterParams(), {
      initialEntries: ["/llm-calls"],
    })
    expect(result.current.spec).toEqual(["wireApi", "model", "serverIp"])
    expect(result.current.params).toEqual({
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
    })
  })

  it("returns only serverIp-spec for /http-exchanges (wireApi/model omitted even if set)", () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: 0,
      end: 1,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const { result } = renderHookWithProviders(() => useSupportedFilterParams(), {
      initialEntries: ["/http-exchanges"],
    })
    expect(result.current.spec).toEqual(["serverIp"])
    // wireApi/model aren't in the route spec → omitted from params.
    expect(result.current.params).toEqual({ server_ip: "10.0.0.1" })
  })

  it("returns [] spec + empty params for /agent-sessions", () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: 0,
      end: 1,
      filters: { wireApi: "anthropic", model: "claude-3", serverIp: "10.0.0.1" },
      refreshInterval: 5000,
    })
    const { result } = renderHookWithProviders(() => useSupportedFilterParams(), {
      initialEntries: ["/agent-sessions"],
    })
    expect(result.current.spec).toEqual([])
    expect(result.current.params).toEqual({})
  })

  it("omits empty-string filters (empty = 'all')", () => {
    resetStore(useToolbarStore, {
      preset: "custom",
      start: 0,
      end: 1,
      filters: { wireApi: "", model: "claude-3", serverIp: "" },
      refreshInterval: 5000,
    })
    const { result } = renderHookWithProviders(() => useSupportedFilterParams(), {
      initialEntries: ["/llm-calls"],
    })
    expect(result.current.params).toEqual({ model: "claude-3" })
  })

  it("returns [] spec for an unknown route", () => {
    const { result } = renderHookWithProviders(() => useSupportedFilterParams(), {
      initialEntries: ["/no-such-page"],
    })
    expect(result.current.spec).toEqual([])
    expect(result.current.params).toEqual({})
  })
})
