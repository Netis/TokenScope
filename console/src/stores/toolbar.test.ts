import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { resetStore } from "../../test/mocks"
import {
  PRESET_SECONDS,
  TOOLBAR_DEFAULTS,
  isValidPreset,
  useToolbarStore,
} from "./toolbar"

// Pin the clock: the store derives start/end from Date.now() for presets and
// at creation. A fixed "now" makes setPreset / initial-state assertions exact.
const NOW_S = 1_780_000_000 // unix seconds (mid-2026)
let restoreNow: () => void

beforeEach(() => {
  const orig = Date.now
  // @ts-expect-error — narrowing the global getter is intentional in tests
  Date.now = () => NOW_S * 1000
  restoreNow = () => {
    Date.now = orig
  }
})

afterEach(() => {
  // Reset to the default-preset window so the next test starts clean.
  resetStore(useToolbarStore, {
    preset: "1h",
    start: NOW_S - PRESET_SECONDS["1h"],
    end: NOW_S,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
  restoreNow()
})

describe("PRESET_SECONDS + isValidPreset", () => {
  it("maps each named preset to its duration in seconds", () => {
    expect(PRESET_SECONDS["5m"]).toBe(300)
    expect(PRESET_SECONDS["15m"]).toBe(900)
    expect(PRESET_SECONDS["1h"]).toBe(3600)
    expect(PRESET_SECONDS["6h"]).toBe(6 * 3600)
    expect(PRESET_SECONDS["24h"]).toBe(24 * 3600)
    expect(PRESET_SECONDS["7d"]).toBe(7 * 24 * 3600)
  })

  it("isValidPreset is true for every named preset + 'custom', false otherwise", () => {
    expect(isValidPreset("5m")).toBe(true)
    expect(isValidPreset("custom")).toBe(true)
    expect(isValidPreset("2m")).toBe(false)
    expect(isValidPreset("")).toBe(false)
    expect(isValidPreset("1h ")).toBe(false)
  })

  it("isValidPreset narrows to the type (assignment check)", () => {
    const v: string = "15m"
    if (isValidPreset(v)) {
      // TS: v is now TimeRangePreset
      const _t: "5m" | "15m" | "1h" | "6h" | "24h" | "7d" | "custom" = v
      void _t
    }
  })
})

describe("TOOLBAR_DEFAULTS", () => {
  it("lists the documented defaults", () => {
    expect(TOOLBAR_DEFAULTS.preset).toBe("1h")
    expect(TOOLBAR_DEFAULTS.wireApi).toBe("")
    expect(TOOLBAR_DEFAULTS.model).toBe("")
    expect(TOOLBAR_DEFAULTS.serverIp).toBe("")
    expect(TOOLBAR_DEFAULTS.refreshInterval).toBe(5000)
  })
})

describe("useToolbarStore — presets", () => {
  it("setPreset slides the window to [now-duration, now] keeping the preset", () => {
    useToolbarStore.getState().setPreset("15m")
    const s = useToolbarStore.getState()
    expect(s.preset).toBe("15m")
    expect(s.start).toBe(NOW_S - 900)
    expect(s.end).toBe(NOW_S)
  })

  it("setCustomRange switches to 'custom' with absolute start/end and pauses auto-refresh", () => {
    useToolbarStore.getState().setCustomRange(NOW_S - 1000, NOW_S - 10)
    const s = useToolbarStore.getState()
    expect(s.preset).toBe("custom")
    expect(s.start).toBe(NOW_S - 1000)
    expect(s.end).toBe(NOW_S - 10)
    // Custom disables auto-refresh (refreshInterval → 0).
    expect(s.refreshInterval).toBe(0)
  })
})

describe("useToolbarStore — filters", () => {
  it("setFilter updates a single dimension filter, leaving others untouched", () => {
    useToolbarStore.getState().setFilter("wireApi", "anthropic")
    expect(useToolbarStore.getState().filters.wireApi).toBe("anthropic")
    expect(useToolbarStore.getState().filters.model).toBe("")

    useToolbarStore.getState().setFilter("model", "claude-3")
    expect(useToolbarStore.getState().filters.model).toBe("claude-3")
    expect(useToolbarStore.getState().filters.wireApi).toBe("anthropic")
  })

  it("setFilter can clear a filter back to empty", () => {
    useToolbarStore.getState().setFilter("serverIp", "10.0.0.1")
    useToolbarStore.getState().setFilter("serverIp", "")
    expect(useToolbarStore.getState().filters.serverIp).toBe("")
  })
})

describe("useToolbarStore — refresh interval", () => {
  it("setRefreshInterval updates the interval (0 = off)", () => {
    useToolbarStore.getState().setRefreshInterval(10000)
    expect(useToolbarStore.getState().refreshInterval).toBe(10000)
    useToolbarStore.getState().setRefreshInterval(0)
    expect(useToolbarStore.getState().refreshInterval).toBe(0)
  })
})

describe("useToolbarStore — _hydrate (URL batch-set)", () => {
  it("patches only the provided fields (partial merge)", () => {
    useToolbarStore.getState().setPreset("15m")
    useToolbarStore.getState()._hydrate({ refreshInterval: 1000 })
    const s = useToolbarStore.getState()
    expect(s.refreshInterval).toBe(1000)
    // Unmentioned fields preserved.
    expect(s.preset).toBe("15m")
  })

  it("replaces only the named filter keys (filter merge)", () => {
    useToolbarStore.getState().setFilter("wireApi", "anthropic")
    useToolbarStore.getState().setFilter("model", "claude")
    useToolbarStore.getState()._hydrate({ filters: { model: "" } })
    const f = useToolbarStore.getState().filters
    expect(f.wireApi).toBe("anthropic") // preserved (not in patch)
    expect(f.model).toBe("") // merged-over
    expect(f.serverIp).toBe("") // untouched
  })

  it("sets preset / start / end / refreshInterval when provided", () => {
    useToolbarStore.getState()._hydrate({
      preset: "custom",
      start: 100,
      end: 200,
      refreshInterval: 2500,
    })
    const s = useToolbarStore.getState()
    expect(s.preset).toBe("custom")
    expect(s.start).toBe(100)
    expect(s.end).toBe(200)
    expect(s.refreshInterval).toBe(2500)
  })

  it("leaves all fields unchanged when the patch is empty", () => {
    // An empty patch still calls set (zustand produces a new state object),
    // but no observable field changes.
    const before = useToolbarStore.getState()
    useToolbarStore.getState()._hydrate({})
    const after = useToolbarStore.getState()
    expect(after.preset).toBe(before.preset)
    expect(after.start).toBe(before.start)
    expect(after.end).toBe(before.end)
    expect(after.refreshInterval).toBe(before.refreshInterval)
    expect(after.filters).toEqual(before.filters)
  })
})
