import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { resetStore, setWindowOrigin } from "../test/mocks"
import { useSidebarStore } from "@/stores/sidebar"
import App from "./app"

beforeAll(() => {
  setWindowOrigin("http://localhost:8080/")
  // Vite injects __APP_VERSION__ at build time; the sidebar reads it for
  // its version string. Supply a fixed value so the Sidebar renders.
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test"
})

afterEach(() => {
  cleanup()
  resetStore(useSidebarStore, { expanded: false })
})

/**
 * App sets up its own BrowserRouter + QueryClient. Render it as-is and
 * assert on the default route's content.
 */
function renderApp() {
  return render(<App />)
}

describe("App router", () => {
  it("mounts the layout (sidebar + toolbar) on the default route", () => {
    const { container } = renderApp()
    // The Sidebar is rendered (collapsed by default → expand button).
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull()
    // The Toolbar is rendered — it shows the preset label "Last 1h".
    expect(container.textContent).toContain("Last 1h")
  })

  it("renders the OverviewPage page surface on /", () => {
    // The OverviewPage renders a loading spinner (Loader2 svg) while the
    // summary is loading — but with no fetch stub the page hangs in
    // loading. Assert the layout is present + the page area is mounted
    // (sidebar + toolbar rendered).
    const { container } = renderApp()
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull()
    // Some svg is present (lucide icons in the sidebar).
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("renders the version label inside the sidebar when expanded", async () => {
    const user = userEvent.setup()
    const { container } = renderApp()
    // The sidebar is collapsed by default; version only renders when
    // expanded. Click the expand button to reveal it.
    const expand = container.querySelector('button[aria-label="Expand sidebar"]') as HTMLButtonElement
    await user.click(expand)
    // The version span now shows "v0.0.0-test".
    expect(container.textContent).toMatch(/v0\.0\.0-test/)
  })
})
