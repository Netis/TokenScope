import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { waitFor } from "@testing-library/react"
import { renderHookWithProviders, resetStore, setWindowOrigin } from "../../test/mocks"
import { PRESET_SECONDS, useToolbarStore } from "@/stores/toolbar"
import { useAutoRefresh } from "./use-auto-refresh"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

// useToolbarStore is a module singleton shared across test files in one bun
// worker process. Replacing one of its action methods with a spy would leak
// that spy into every later file in the process (e.g. use-url-sync's
// setPreset would become a no-op). So we capture the real actions up front and
// restore them — and the whole window — in afterEach.
const REAL_ACTIONS = {
  setPreset: useToolbarStore.getState().setPreset,
  setCustomRange: useToolbarStore.getState().setCustomRange,
  setFilter: useToolbarStore.getState().setFilter,
  setRefreshInterval: useToolbarStore.getState().setRefreshInterval,
  _hydrate: useToolbarStore.getState()._hydrate,
}

function restoreStore() {
  resetStore(useToolbarStore, {
    preset: "1h",
    start: 0,
    end: PRESET_SECONDS["1h"],
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
    setPreset: REAL_ACTIONS.setPreset,
    setCustomRange: REAL_ACTIONS.setCustomRange,
    setFilter: REAL_ACTIONS.setFilter,
    setRefreshInterval: REAL_ACTIONS.setRefreshInterval,
    _hydrate: REAL_ACTIONS._hydrate,
  })
}

// useAutoRefresh reads refreshInterval + preset off the toolbar store and
// calls setPreset on an interval — skipped when refreshInterval <= 0 or the
// preset is "custom". We spy on setPreset to assert the cadence + the guard.
// A short refreshInterval (25ms) keeps the suite fast.
function renderWith(refreshInterval: number, preset: string, spy: ReturnType<typeof mock>) {
  resetStore(useToolbarStore, {
    preset: preset as ReturnType<typeof useToolbarStore.getState>["preset"],
    start: 0,
    end: 0,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval,
    setPreset: spy as unknown as ReturnType<typeof useToolbarStore.getState>["setPreset"],
  })
  return renderHookWithProviders(() => useAutoRefresh())
}

afterEach(() => restoreStore())

describe("useAutoRefresh", () => {
  it("calls setPreset on the interval when refreshInterval > 0 and preset is not custom", async () => {
    const spy = mock(() => {})
    const { unmount } = renderWith(25, "1h", spy)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 500 })
    // A second tick confirms it's recurring, not one-shot.
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 500 })
    unmount()
  })

  it("does NOT call setPreset when refreshInterval <= 0", async () => {
    const spy = mock(() => {})
    const { unmount } = renderWith(0, "1h", spy)
    // Wait past a couple of would-be ticks.
    await new Promise((r) => setTimeout(r, 60))
    expect(spy).not.toHaveBeenCalled()
    unmount()
  })

  it("does NOT call setPreset when the preset is 'custom'", async () => {
    const spy = mock(() => {})
    const { unmount } = renderWith(25, "custom", spy)
    await new Promise((r) => setTimeout(r, 60))
    expect(spy).not.toHaveBeenCalled()
    unmount()
  })
})
