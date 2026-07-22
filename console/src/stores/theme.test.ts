import { afterEach, describe, expect, it } from "bun:test"
import { resetStore } from "../../test/mocks"
import { initTheme, useThemeStore, type ThemeMode } from "./theme"

const ALL_CLASSES: ThemeMode[] = ["dark", "light", "kami"]

afterEach(() => {
  resetStore(useThemeStore, { theme: "kami" })
  // Clear any theme classes initTheme applied to <html> so the DOM is clean
  // for the next test / file.
  for (const c of ALL_CLASSES) document.documentElement.classList.remove(c)
})

describe("useThemeStore", () => {
  it("defaults to 'kami'", () => {
    expect(useThemeStore.getState().theme).toBe("kami")
  })

  it("setTheme sets an explicit theme", () => {
    useThemeStore.getState().setTheme("dark")
    expect(useThemeStore.getState().theme).toBe("dark")
    useThemeStore.getState().setTheme("light")
    expect(useThemeStore.getState().theme).toBe("light")
  })

  it("cycleTheme walks dark → light → kami → dark …", () => {
    useThemeStore.getState().setTheme("dark")
    useThemeStore.getState().cycleTheme()
    expect(useThemeStore.getState().theme).toBe("light")
    useThemeStore.getState().cycleTheme()
    expect(useThemeStore.getState().theme).toBe("kami")
    useThemeStore.getState().cycleTheme()
    expect(useThemeStore.getState().theme).toBe("dark")
  })
})

describe("initTheme", () => {
  it("applies the current theme class to <html> immediately", () => {
    useThemeStore.getState().setTheme("light")
    initTheme()
    expect(document.documentElement.classList.contains("light")).toBe(true)
    expect(document.documentElement.classList.contains("kami")).toBe(false)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("re-applies the class when the theme changes (subscribe)", () => {
    useThemeStore.getState().setTheme("dark")
    initTheme()
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    useThemeStore.getState().setTheme("kami")
    // The subscription re-applies on every change.
    expect(document.documentElement.classList.contains("kami")).toBe(true)
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("replaces the prior class (no accumulation)", () => {
    useThemeStore.getState().setTheme("dark")
    initTheme()
    useThemeStore.getState().setTheme("light")
    useThemeStore.getState().setTheme("kami")
    const html = document.documentElement
    const present = ALL_CLASSES.filter((c) => html.classList.contains(c))
    expect(present).toEqual(["kami"])
  })
})
