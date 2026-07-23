import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { resetStore } from "../../../test/mocks"
import { renderPage } from "../../../test/fixtures"
import { useSidebarStore } from "@/stores/sidebar"
import { useThemeStore } from "@/stores/theme"
import { Sidebar } from "./sidebar"

// __APP_VERSION__ is injected by Vite's `define` at build time; the test
// runner doesn't run Vite, so declare a fixed value once per file.
beforeAll(() => {
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test"
})

afterEach(() => {
  cleanup()
  resetStore(useSidebarStore, { expanded: false })
  resetStore(useThemeStore, { theme: "kami" })
})

describe("Sidebar", () => {
  it("renders collapsed by default with the icon-only logo", () => {
    const { container } = renderPage(<Sidebar />)
    // Collapsed shows the "Expand sidebar" button (the icon logo is an SVG,
    // so the textContent doesn't include "Heron" — the wordmark is only
    // shown when expanded).
    expect(getButtonByLabel(container, "Expand sidebar")).not.toBeNull()
    // The svg logo is present.
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("expands on toggle and shows the collapse button", async () => {
    const user = userEvent.setup()
    const { container } = renderPage(<Sidebar />)
    // Click the expand button.
    await user.click(getButtonByLabel(container, "Expand sidebar")!)
    // Now expanded — collapse button appears.
    expect(getButtonByLabel(container, "Collapse sidebar")).not.toBeNull()
    // Nav labels become visible.
    expect(container.textContent).toContain("Overview")
    expect(container.textContent).toContain("Settings")
  })

  it("collapses back on a second toggle", async () => {
    const user = userEvent.setup()
    // Pre-set expanded to start expanded.
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderPage(<Sidebar />)
    expect(getButtonByLabel(container, "Collapse sidebar")).not.toBeNull()

    await user.click(getButtonByLabel(container, "Collapse sidebar")!)
    // After collapse, only expand is available.
    expect(getButtonByLabel(container, "Expand sidebar")).not.toBeNull()
    expect(getButtonByLabel(container, "Collapse sidebar")).toBeNull()
  })

  it("renders the Observe group links when expanded", () => {
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderPage(<Sidebar />)
    for (const label of ["Overview", "Performance", "Usage", "Errors"]) {
      expect(container.textContent).toContain(label)
    }
  })

  it("renders the Explore group links when expanded", () => {
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderPage(<Sidebar />)
    for (const label of [
      "Services",
      "Agent Sessions",
      "Agent Traces",
      "LLM Calls",
      "HTTP Logs",
    ]) {
      expect(container.textContent).toContain(label)
    }
  })

  it("renders the Settings nav link when expanded", () => {
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderPage(<Sidebar />)
    expect(container.textContent).toContain("Settings")
  })

  it("renders the version string when expanded", () => {
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderPage(<Sidebar />)
    // __APP_VERSION__ is injected at build time; the span starts with "v".
    // Match the version pattern: starts with "v" followed by a digit.
    expect(container.textContent).toMatch(/v\d+\.\d+/)
  })

  it("does not render the version when collapsed", () => {
    const { container } = renderPage(<Sidebar />)
    // Collapsed hides the version string.
    expect(container.textContent).not.toMatch(/v\d+\.\d+/)
  })

  it("cycles the theme when the theme button is clicked", async () => {
    const user = userEvent.setup()
    resetStore(useSidebarStore, { expanded: true })
    // Start at "kami" (default in the store).
    resetStore(useThemeStore, { theme: "kami" })
    const { container } = renderPage(<Sidebar />)

    // The theme button shows the current theme label and a hover tooltip
    // describing the next theme. The button is the one with the
    // "Theme: <cur> → <next>" title attribute.
    const themeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.getAttribute("title") ?? "").startsWith("Theme:"),
    )!
    expect(themeBtn).not.toBeUndefined()
    // Initial: kami → dark (the cycle is dark → light → kami → dark).
    expect(themeBtn.getAttribute("title")).toContain("Kami")
    expect(themeBtn.getAttribute("title")).toContain("Dark")

    // Click to cycle: kami → dark.
    await user.click(themeBtn)
    expect(useThemeStore.getState().theme).toBe("dark")
  })

  it("renders the theme label for the current theme when expanded", () => {
    resetStore(useSidebarStore, { expanded: true })
    resetStore(useThemeStore, { theme: "dark" })
    const { container } = renderPage(<Sidebar />)
    // Theme label rendered as text alongside the icon.
    expect(container.textContent).toContain("Dark")
  })

  it("preserves toolbar search params on the nav links", () => {
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderPage(<Sidebar />, {
      initialEntries: ["/?preset=6h&model=gpt-4o&wire_api=openai-chat"],
    })
    // The Settings link should carry the toolbar keys forward.
    const settingsLink = Array.from(container.querySelectorAll("a")).find(
      (a) => (a.getAttribute("href") ?? "").startsWith("/settings"),
    )!
    expect(settingsLink).not.toBeUndefined()
    const href = settingsLink.getAttribute("href") ?? ""
    // preset + model + wire_api survive on the URL; refresh survives too (default).
    expect(href).toContain("preset=6h")
    expect(href).toContain("model=gpt-4o")
    expect(href).toContain("wire_api=openai-chat")
  })

  it("strips non-toolbar keys from the nav link href", () => {
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderPage(<Sidebar />, {
      initialEntries: ["/?preset=1h&selected=turn-42&selected_at=999"],
    })
    // 'selected' and 'selected_at' are NOT in TOOLBAR_KEYS, so they should
    // NOT survive on the link href.
    const settingsLink = Array.from(container.querySelectorAll("a")).find(
      (a) => (a.getAttribute("href") ?? "").startsWith("/settings"),
    )!
    const href = settingsLink.getAttribute("href") ?? ""
    expect(href).not.toContain("selected")
    expect(href).not.toContain("selected_at")
    // Toolbar keys are still preserved.
    expect(href).toContain("preset=1h")
  })
})

/** Find a button by its aria-label (avoids screen.getByRole issues when
 *  RTL auto-cleanup doesn't fire between tests in the same file). */
function getButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${label}"]`)
}
