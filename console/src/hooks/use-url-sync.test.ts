import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { act, waitFor } from "@testing-library/react"
import { useLocation } from "react-router"
import {
  pinClock,
  renderHookWithProviders,
  resetStore,
  setWindowOrigin,
} from "../../test/mocks"
import { PRESET_SECONDS, useToolbarStore } from "@/stores/toolbar"
import { useToolbarUrlSync } from "./use-url-sync"

const NOW_S = 1_780_000_000
let restoreClock: () => void

beforeAll(() => setWindowOrigin("http://localhost:8080/"))
beforeEach(() => {
  restoreClock = pinClock(NOW_S * 1000)
  resetStore(useToolbarStore, {
    preset: "1h",
    start: NOW_S - PRESET_SECONDS["1h"],
    end: NOW_S,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
})
afterEach(() => restoreClock())

// Renders useToolbarUrlSync alongside a useLocation() reader so the test can
// assert on the URL the router settled to after a sync. Both share the one
// MemoryRouter created by renderHookWithProviders(initialEntries).
function renderSync(initialPath: string) {
  return renderHookWithProviders(
    () => {
      useToolbarUrlSync()
      return useLocation().search
    },
    { initialEntries: [initialPath] },
  )
}

function searchParams(search: string): URLSearchParams {
  return new URLSearchParams(search)
}

describe("useToolbarUrlSync — URL → store", () => {
  it("hydrates preset + window from a relative-preset URL", async () => {
    const { result } = renderSync("/llm-calls?preset=15m")
    await waitFor(() => expect(useToolbarStore.getState().preset).toBe("15m"))
    expect(useToolbarStore.getState().start).toBe(NOW_S - PRESET_SECONDS["15m"])
    expect(useToolbarStore.getState().end).toBe(NOW_S)
    void result
  })

  it("hydrates absolute start/end from a custom-preset URL", async () => {
    const { result } = renderSync("/llm-calls?preset=custom&start=100&end=200")
    await waitFor(() => expect(useToolbarStore.getState().preset).toBe("custom"))
    expect(useToolbarStore.getState().start).toBe(100)
    expect(useToolbarStore.getState().end).toBe(200)
    void result
  })

  it("hydrates dimension filters present in the URL", async () => {
    const { result } = renderSync(
      "/llm-calls?wire_api=anthropic&model=claude-3&server_ip=10.0.0.1",
    )
    await waitFor(() => expect(useToolbarStore.getState().filters.wireApi).toBe("anthropic"))
    expect(useToolbarStore.getState().filters.model).toBe("claude-3")
    expect(useToolbarStore.getState().filters.serverIp).toBe("10.0.0.1")
    void result
  })

  it("hydrates a non-default refresh interval", async () => {
    const { result } = renderSync("/llm-calls?refresh=15000")
    await waitFor(() => expect(useToolbarStore.getState().refreshInterval).toBe(15000))
    void result
  })

  it("ignores an invalid preset value (no preset set)", async () => {
    const { result } = renderSync("/llm-calls?preset=bogus")
    await new Promise((r) => setTimeout(r, 20))
    expect(useToolbarStore.getState().preset).toBe("1h") // default unchanged
    void result
  })
})

describe("useToolbarUrlSync — store → URL", () => {
  it("writes a non-default preset to the URL", async () => {
    const { result } = renderSync("/llm-calls")
    await act(async () => {
      useToolbarStore.getState().setPreset("15m")
    })
    await waitFor(() =>
      expect(searchParams(result.current).get("preset")).toBe("15m"),
    )
  })

  it("writes absolute start/end when preset is custom", async () => {
    const { result } = renderSync("/llm-calls")
    await act(async () => {
      useToolbarStore.getState().setCustomRange(100, 200)
    })
    await waitFor(() => expect(searchParams(result.current).get("preset")).toBe("custom"))
    expect(searchParams(result.current).get("start")).toBe("100")
    expect(searchParams(result.current).get("end")).toBe("200")
  })

  it("writes the route-supported dimension filters (and omits the default preset)", async () => {
    const { result } = renderSync("/llm-calls")
    await act(async () => {
      useToolbarStore.getState().setFilter("wireApi", "anthropic")
      useToolbarStore.getState().setFilter("model", "claude-3")
      useToolbarStore.getState().setFilter("serverIp", "10.0.0.1")
    })
    await waitFor(() => expect(searchParams(result.current).get("wire_api")).toBe("anthropic"))
    const qs = searchParams(result.current)
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
    // Default preset ("1h") is omitted.
    expect(qs.has("preset")).toBe(false)
  })

  it("strips dimension filters not supported by the current route (serverIp only on /http-exchanges)", async () => {
    const { result } = renderSync("/http-exchanges")
    await act(async () => {
      useToolbarStore.getState().setFilter("wireApi", "anthropic")
      useToolbarStore.getState().setFilter("model", "claude-3")
      useToolbarStore.getState().setFilter("serverIp", "10.0.0.1")
    })
    await waitFor(() => expect(searchParams(result.current).get("server_ip")).toBe("10.0.0.1"))
    const qs = searchParams(result.current)
    expect(qs.has("wire_api")).toBe(false) // not in /http-exchanges spec
    expect(qs.has("model")).toBe(false)
  })

  it("writes a non-default refresh interval", async () => {
    const { result } = renderSync("/llm-calls")
    await act(async () => {
      useToolbarStore.getState().setRefreshInterval(15000)
    })
    await waitFor(() => expect(searchParams(result.current).get("refresh")).toBe("15000"))
  })
})
