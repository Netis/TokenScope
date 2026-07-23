import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import {
  createTestQueryClient,
  resetStore,
  setWindowOrigin,
} from "../../../test/mocks"
import { useSidebarStore } from "@/stores/sidebar"
import { AppLayout } from "./app-layout"

beforeAll(() => {
  setWindowOrigin("http://localhost:8080/")
  // Vite injects __APP_VERSION__ at build time; supply a fixed value for tests.
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test"
})

afterEach(() => {
  cleanup()
  resetStore(useSidebarStore, { expanded: false })
})

/** Helper page that just renders a marker text inside <Outlet/>. */
function Marker() {
  return <div data-testid="page-marker">page-content</div>
}

function renderLayoutAt(path: string = "/") {
  const qc = createTestQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Marker />} />
            <Route path="/llm-calls" element={<Marker />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("AppLayout", () => {
  it("renders the sidebar, toolbar and the page outlet content", () => {
    const { container } = renderLayoutAt("/")
    // Sidebar is present (collapsed by default — shows the expand button).
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).not.toBeNull()
    // The Outlet child renders.
    expect(container.textContent).toContain("page-content")
  })

  it("renders the sidebar at the collapsed width (ml-[44px])", () => {
    const { container } = renderLayoutAt("/")
    // The main column wrapper has class "ml-[44px]" when collapsed.
    const wrapper = container.querySelector(".ml-\\[44px\\]")
    expect(wrapper).not.toBeNull()
  })

  it("renders the sidebar at the expanded width (ml-[200px]) when the store is expanded", () => {
    resetStore(useSidebarStore, { expanded: true })
    const { container } = renderLayoutAt("/")
    const wrapper = container.querySelector(".ml-\\[200px\\]")
    expect(wrapper).not.toBeNull()
  })

  it("shifts the main column when the sidebar toggles between renders", () => {
    // Start collapsed.
    resetStore(useSidebarStore, { expanded: false })
    const r = renderLayoutAt("/")
    expect(r.container.querySelector(".ml-\\[44px\\]")).not.toBeNull()
    // Mutate the store to expand — the layout re-renders.
    resetStore(useSidebarStore, { expanded: true })
    // Force a re-render by re-rendering at a fresh router mount — the new
    // store state should now drive the wrapper width.
    cleanup()
    const r2 = renderLayoutAt("/")
    expect(r2.container.querySelector(".ml-\\[200px\\]")).not.toBeNull()
  })

  it("renders the toolbar inside the layout header", () => {
    const { container } = renderLayoutAt("/")
    // The toolbar's preset label "Last 1h" is present (default preset).
    expect(container.textContent).toContain("Last 1h")
  })

  it("renders the page outlet for the active route", () => {
    const { container } = renderLayoutAt("/llm-calls")
    // Only one marker should render (the matched route).
    const markers = container.querySelectorAll('[data-testid="page-marker"]')
    expect(markers.length).toBe(1)
  })
})
