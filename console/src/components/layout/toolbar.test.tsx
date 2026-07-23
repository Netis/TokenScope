import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { MemoryRouter } from "react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import {
  createTestQueryClient,
  mockFetch,
  jsonResponse,
  resetStore,
  setWindowOrigin,
} from "../../../test/mocks"
import { renderPage } from "../../../test/fixtures"
import { useToolbarStore } from "@/stores/toolbar"
import { Toolbar } from "./toolbar"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

afterEach(() => {
  cleanup()
  // Reset the toolbar store to a deterministic 1h window after each test
  // so any in-test mutations don't leak across tests in the same file.
  resetStore(useToolbarStore, {
    preset: "1h",
    start: 1_780_000_000 - 3600,
    end: 1_780_000_000,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
})

/** Stub fetch to return filter-value responses for /api/filters/* and a
 *  generic empty for everything else. */
function stubFilters() {
  mockFetch((input) => {
    const url = String(input)
    if (url.includes("/api/filters/wire-apis")) {
      return jsonResponse({ code: 0, message: "ok", data: { values: ["anthropic", "openai-chat"] } })
    }
    if (url.includes("/api/filters/models")) {
      return jsonResponse({ code: 0, message: "ok", data: { values: ["claude-sonnet-4", "gpt-4o"] } })
    }
    if (url.includes("/api/filters/server-ips")) {
      return jsonResponse({ code: 0, message: "ok", data: { values: ["10.0.0.1"] } })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

/** Render with explicit MemoryRouter + QueryClientProvider WITHOUT the
 *  renderPage toolbar-window reset — use when a test deliberately presets
 *  the toolbar store to something other than the 1h default. */
function renderWithRouter(ui: React.ReactNode, initialEntries: string[] = ["/llm-calls"]) {
  const qc = createTestQueryClient()
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  )
}

describe("Toolbar", () => {
  it("renders the preset button with the current preset label", () => {
    // Render at a route whose spec includes all 3 filters so all three
    // FilterDropdown components mount.
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    expect(container.textContent).toContain("Last 1h")
  })

  it("opens the dropdown to reveal the preset quick-select buttons", async () => {
    const user = userEvent.setup()
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    // Click the time-range dropdown toggle (the button carrying the
    // Calendar icon and the preset label).
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Last 1h"),
    )!
    await user.click(toggle)
    // The Quick Select section appears, with all the preset labels.
    expect(container.textContent).toContain("Quick Select")
    for (const label of ["Last 5m", "Last 15m", "Last 1h", "Last 6h", "Last 24h", "Last 7d"]) {
      expect(container.textContent).toContain(label)
    }
  })

  it("switches the preset when a quick-select chip is clicked", async () => {
    const user = userEvent.setup()
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Last 1h"),
    )!
    await user.click(toggle)
    // Click "Last 24h" — it's a button with text "Last 24h".
    const preset24h = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Last 24h",
    )!
    await user.click(preset24h)
    // Store preset is now 24h.
    expect(useToolbarStore.getState().preset).toBe("24h")
  })

  it("shows the auto-refresh label and spinner when refreshInterval > 0", () => {
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    // The toolbar shows the "5s" refresh label (default 5000ms).
    expect(container.textContent).toContain("5s")
  })

  it("renders the Wire API filter dropdown on a route whose spec includes it", () => {
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    expect(container.textContent).toContain("Wire API")
    expect(container.textContent).toContain("Model")
    expect(container.textContent).toContain("Server IP")
  })

  it("does NOT render the Wire API filter dropdown on a route whose spec omits it", () => {
    // /agent-sessions supports no filters (empty spec).
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/agent-sessions"],
    })
    expect(container.textContent).not.toContain("Wire API")
    expect(container.textContent).not.toContain("Server IP")
    // Only server-ip dropdown on /http-exchanges.
    const httpCont = renderPage(<Toolbar />, {
      initialEntries: ["/http-exchanges"],
    }).container
    expect(httpCont.textContent).toContain("Server IP")
    expect(httpCont.textContent).not.toContain("Wire API")
  })

  it("opens the custom-range editor when the dropdown is open", async () => {
    const user = userEvent.setup()
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Last 1h"),
    )!
    await user.click(toggle)
    expect(container.textContent).toContain("Custom Range")
    expect(container.textContent).toContain("From")
    expect(container.textContent).toContain("To")
    // The Apply button is present.
    const apply = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Apply",
    )!
    expect(apply).not.toBeUndefined()
  })

  it("renders the Auto Refresh section with interval buttons", async () => {
    const user = userEvent.setup()
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Last 1h"),
    )!
    await user.click(toggle)
    expect(container.textContent).toContain("Auto Refresh")
    for (const label of ["Off", "5s", "10s", "30s", "1m"]) {
      expect(container.textContent).toContain(label)
    }
  })

  it("changes the refresh interval when an interval chip is clicked", async () => {
    const user = userEvent.setup()
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Last 1h"),
    )!
    await user.click(toggle)
    // Click "Off" (value=0).
    const off = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Off",
    )!
    await user.click(off)
    expect(useToolbarStore.getState().refreshInterval).toBe(0)
  })

  it("shows the custom range label when preset is custom", () => {
    stubFilters()
    // Bypass renderPage's resetToolbarWindow — preset the store AFTER
    // initialising the router so the custom preset survives to render.
    resetStore(useToolbarStore, {
      preset: "custom",
      start: 1_780_000_000 - 600,
      end: 1_780_000_000,
      filters: { wireApi: "", model: "", serverIp: "" },
      refreshInterval: 0,
    })
    const { container } = renderWithRouter(<Toolbar />, ["/llm-calls"])
    // Custom range renders a formatted "MM-DD HH:MM ~ MM-DD HH:MM" label.
    expect(container.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2} ~ \d{2}-\d{2} \d{2}:\d{2}/)
  })

  it("applies a custom range via the Apply button", async () => {
    const user = userEvent.setup()
    stubFilters()
    const { container } = renderPage(<Toolbar />, {
      initialEntries: ["/llm-calls"],
    })
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Last 1h"),
    )!
    await user.click(toggle)
    // Fill the From/To datetime-local inputs and click Apply.
    const inputs = container.querySelectorAll('input[type="datetime-local"]')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    await user.clear(inputs[0]!)
    await user.type(inputs[0]!, "2026-01-01T00:00")
    await user.clear(inputs[1]!)
    await user.type(inputs[1]!, "2026-01-01T01:00")
    const apply = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Apply",
    )!
    await user.click(apply)
    // Store is now custom with the typed range (epoch seconds).
    expect(useToolbarStore.getState().preset).toBe("custom")
    expect(useToolbarStore.getState().start).toBeLessThan(useToolbarStore.getState().end)
    // Custom preset disables auto-refresh.
    expect(useToolbarStore.getState().refreshInterval).toBe(0)
  })

  it("closes the dropdown when an outside click fires", async () => {
    const user = userEvent.setup()
    stubFilters()
    const { container } = renderPage(
      <>
        <Toolbar />
        <button>elsewhere</button>
      </>,
      { initialEntries: ["/llm-calls"] },
    )
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Last 1h"),
    )!
    await user.click(toggle)
    // Dropdown contents are now visible.
    expect(container.textContent).toContain("Quick Select")
    // Click outside — the "elsewhere" button.
    const outside = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "elsewhere",
    )!
    await user.click(outside)
    // Quick Select should be gone now.
    expect(container.textContent).not.toContain("Quick Select")
  })
})
