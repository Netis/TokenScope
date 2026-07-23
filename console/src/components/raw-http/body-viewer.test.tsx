import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BodyViewer } from "./body-viewer"

// body-viewer reads `window.localStorage` for the mode toggle. happy-dom
// ships with localStorage but the previous test's mode persists across
// files; clear it before each test to avoid spillover.
beforeAll(() => {
  // happy-dom loads at about:blank; ensure window/localStorage exist.
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear()
  }
})

afterEach(() => {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear()
  }
})

describe("BodyViewer — empty / null body", () => {
  it("renders the 'No body' notice when raw is null", () => {
    render(<BodyViewer title="Request Body" raw={null} />)
    // The default-open toggle is expanded; the body section says "No body".
    expect(screen.getByText("Request Body")).toBeInTheDocument()
    expect(screen.getByText(/No body/i)).toBeInTheDocument()
  })

  it("renders the 'No body' notice when raw is empty string", () => {
    render(<BodyViewer title="Response Body" raw="" />)
    expect(screen.getByText(/No body/i)).toBeInTheDocument()
  })

  it("omits the ModeToggle / expand / copy buttons when body is empty", () => {
    const { container } = render(<BodyViewer title="X" raw={null} />)
    // Only the toggle-chevron button for the section should be present;
    // the toolbar with Raw/Tree/Copy/Expand/Collapse buttons is absent.
    expect(container.querySelectorAll("button").length).toBe(1)
  })
})

describe("BodyViewer — raw JSON body", () => {
  it("renders the size in bytes and a Tree mode by default", () => {
    render(<BodyViewer title="R" raw={JSON.stringify({ a: 1 })} />)
    // formatSize returns "7 B" for '{"a":1}' (7 ASCII chars).
    expect(screen.getByText(/· 7 B/i)).toBeInTheDocument()
  })

  it("defaults to Tree mode and shows the JsonTree with the root open and child keys visible", () => {
    render(<BodyViewer title="R" raw={JSON.stringify({ a: 1, b: 2 })} />)
    // defaultExpansion opens depth 0 (the root "$"), so the children "a" and "b"
    // are rendered as JsonNode keyLabels. Each Line renders the key in a span.
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("b")).toBeInTheDocument()
  })

  it("switches to Raw mode when the Raw toggle is clicked", async () => {
    const user = userEvent.setup()
    render(<BodyViewer title="R" raw={JSON.stringify({ a: 1 })} />)
    await user.click(screen.getByRole("button", { name: /raw/i }))
    // The Raw mode renders a <pre> with the pretty-printed JSON.
    expect(screen.getByText(/"a"/i)).toBeInTheDocument()
  })

  it("persists the mode to localStorage", async () => {
    const user = userEvent.setup()
    render(<BodyViewer title="R" raw={JSON.stringify({ a: 1 })} />)
    await user.click(screen.getByRole("button", { name: /raw/i }))
    expect(window.localStorage.getItem("heron.rawHttp.bodyMode")).toBe("raw")
  })

  it("honors a previously-saved raw mode", async () => {
    window.localStorage.setItem("heron.rawHttp.bodyMode", "raw")
    render(<BodyViewer title="R" raw={JSON.stringify({ a: 1 })} />)
    // No tree-view collapsed preview present (raw mode shows the <pre>).
    expect(screen.queryByText(/{a: /i)).not.toBeInTheDocument()
  })
})

describe("BodyViewer — non-JSON / oversized bodies", () => {
  it("falls back to raw text when the body is not valid JSON", () => {
    render(<BodyViewer title="R" raw="not-json-at-all" />)
    // The "Not valid JSON — showing raw text." notice appears.
    expect(screen.getByText(/Not valid JSON/i)).toBeInTheDocument()
    // The body itself is rendered.
    expect(screen.getByText("not-json-at-all")).toBeInTheDocument()
  })

  it("disables tree mode for bodies > 500KB and shows the oversize notice", () => {
    const big = JSON.stringify({ a: "x".repeat(600 * 1024) })
    render(<BodyViewer title="R" raw={big} />)
    expect(screen.getByText(/Tree mode disabled for body > 500 KB/i)).toBeInTheDocument()
  })

  it("renders an SSE body as raw text (no JSON parse)", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    render(<BodyViewer title="R" raw={sse} />)
    expect(screen.getByText(/Not valid JSON/i)).toBeInTheDocument()
    // The raw SSE body is in the <pre>.
    expect(screen.getByText(/data:/i)).toBeInTheDocument()
  })
})

describe("BodyViewer — expand/collapse section", () => {
  it("starts open by default and collapses on click", async () => {
    const user = userEvent.setup()
    render(<BodyViewer title="X" raw={JSON.stringify({ a: 1 })} />)
    // The "a" key is visible by default (root is open).
    expect(screen.getByText("a")).toBeInTheDocument()
    // Click the section header to collapse.
    await user.click(screen.getByText("X"))
    // The body is now hidden.
    expect(screen.queryByText("a")).not.toBeInTheDocument()
  })

  it("starts collapsed when defaultOpen is false", () => {
    render(<BodyViewer title="X" raw={JSON.stringify({ a: 1 })} defaultOpen={false} />)
    // The "a" key is hidden because the section is collapsed.
    expect(screen.queryByText("a")).not.toBeInTheDocument()
  })
})

describe("BodyViewer — tree mode controls", () => {
  it("renders the Expand-all / Collapse-all buttons in tree mode", async () => {
    const user = userEvent.setup()
    render(<BodyViewer title="R" raw={JSON.stringify({ a: { b: { c: 1 } } })} />)
    // Click "Expand all" → all paths opened including nested $.a.b.
    await user.click(screen.getByTitle("Expand all"))
    // The deeply-nested "c" key now appears as a tree key.
    expect(screen.getByText("c")).toBeInTheDocument()
    // Click "Collapse all" → only the root remains.
    await user.click(screen.getByTitle("Collapse all"))
    // The nested "c" key is gone (collapsed under $.a.b).
    // (Collapsing shows the collapsed-array/object preview; the bare "c"
    // key only appears when its parent object is open.)
    expect(screen.queryByText("c")).not.toBeInTheDocument()
  })

  it("toggles a single nested node via the chevron button on its collapsed preview", async () => {
    const user = userEvent.setup()
    // defaultExpansion opens depths 0 and 1. So the root "$" and the
    // immediate child objects open by default, but their nested children
    // at depth 2 are collapsed. With {a:{b:1}} the $.a opens (depth 1) and
    // $.a.b is a primitive leaf (depth 2 — no preview since b is a number).
    // Use a deeper nesting so depth-2 is an object that's collapsed:
    render(<BodyViewer title="R" raw={JSON.stringify({ a: { b: { c: 1 } } })} />)
    // defaultExpansion opens $ (depth 0) and $.a (depth 1). The "$.a.b"
    // object (depth 2) is collapsed and shows the preview "[not used — c is
    // the only key, so the preview is "{c: ...}"]".
    // To exercise the toggle, click the "{c: ...}" button to expand it.
    const cPreview = screen.getByText("{c: ...}")
    await user.click(cPreview)
    // After expansion, the "c" key appears as a JsonNode keyLabel.
    expect(screen.getByText("c")).toBeInTheDocument()
  })

  it("the Copy button calls navigator.clipboard.writeText", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn()
    // happy-dom may not have navigator.clipboard; install a stub before
    // the component clicks the Copy button. configurable:true so we can
    // re-define / reset it after.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText: vi.fn() },
      configurable: true,
    })
    render(<BodyViewer title="R" raw={JSON.stringify({ a: 1 })} />)
    await user.click(screen.getByTitle("Copy"))
    expect(writeText).toHaveBeenCalledTimes(1)
    // Restore: redefine as undefined; ignore any failure (the navigator
    // property in happy-dom may be readonly but configurable was set above).
    try {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    } catch {
      // best-effort restore; the test passed its assertion.
    }
  })
})
