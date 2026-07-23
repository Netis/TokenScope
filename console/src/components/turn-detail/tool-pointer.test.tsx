import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ToolUsePointer, ToolResultBackLink } from "./tool-pointer"
import type { ToolOrigin, ToolResolution } from "@/lib/turn-index"

// ── ToolUsePointer ───────────────────────────────────────────────────────────
describe("ToolUsePointer", () => {
  const healthyResolution: ToolResolution = {
    call_sequence: 3,
    call_id: "call-3",
    is_error: false,
    size_bytes: 42,
    content: "tool output body",
  }

  it("renders the healthy inline-result toggle when state=healthy and resolution present", () => {
    render(<ToolUsePointer state="healthy" resolution={healthyResolution} />)
    // button label references the call sequence number and the size.
    expect(screen.getByText(/result in #3/i)).toBeInTheDocument()
    expect(screen.getByText(/42 B/i)).toBeInTheDocument()
  })

  it("renders an error suffix when the resolution is_error", () => {
    const res: ToolResolution = { ...healthyResolution, is_error: true }
    render(<ToolUsePointer state="healthy" resolution={res} />)
    expect(screen.getByText(/error/i)).toBeInTheDocument()
  })

  it("formats KB when size_bytes >= 1024", () => {
    const res: ToolResolution = { ...healthyResolution, size_bytes: 2048 }
    render(<ToolUsePointer state="healthy" resolution={res} />)
    expect(screen.getByText(/2.0 KB/i)).toBeInTheDocument()
  })

  it("formats MB when size_bytes >= 1MB", () => {
    const res: ToolResolution = {
      ...healthyResolution,
      size_bytes: 1024 * 1024 * 2,
    }
    render(<ToolUsePointer state="healthy" resolution={res} />)
    expect(screen.getByText(/2.0 MB/i)).toBeInTheDocument()
  })

  it("expands to reveal the inline body when the toggle button is clicked", async () => {
    const user = userEvent.setup()
    render(<ToolUsePointer state="healthy" resolution={healthyResolution} />)
    // Content hidden initially.
    expect(screen.queryByText("tool output body")).not.toBeInTheDocument()
    // Click the toggle button.
    await user.click(screen.getByRole("button"))
    expect(await screen.findByText("tool output body")).toBeInTheDocument()
  })

  it("collapses again on a second click", async () => {
    const user = userEvent.setup()
    render(<ToolUsePointer state="healthy" resolution={healthyResolution} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(await screen.findByText("tool output body")).toBeInTheDocument()
    await user.click(btn)
    expect(screen.queryByText("tool output body")).not.toBeInTheDocument()
  })

  it("renders the 'result not captured' notice when state=capture_gap (no resolution)", () => {
    render(<ToolUsePointer state="capture_gap" resolution={null} />)
    expect(screen.getByText(/result not captured/i)).toBeInTheDocument()
    // And the warning icon (lucide AlertTriangle → class `lucide-triangle-alert`).
    expect(document.querySelector(".lucide-triangle-alert")).not.toBeNull()
  })

  it("also falls back to the 'not captured' notice when state=healthy but resolution is null", () => {
    render(<ToolUsePointer state="healthy" resolution={null} />)
    expect(screen.getByText(/result not captured/i)).toBeInTheDocument()
  })

  it("applies the passed className", () => {
    const { container } = render(
      <ToolUsePointer state="capture_gap" resolution={null} className="my-class" />,
    )
    // The notice span inherits the className.
    expect(container.querySelector(".my-class")).not.toBeNull()
  })
})

// ── ToolResultBackLink ───────────────────────────────────────────────────────
describe("ToolResultBackLink", () => {
  const healthyOrigin: ToolOrigin = {
    call_sequence: 5,
    call_id: "call-5",
    tool_name: "get_weather",
    args_json: '{"location":"SF"}',
  }

  it("renders the healthy back-link with call sequence and tool name", () => {
    render(<ToolResultBackLink state="healthy" origin={healthyOrigin} />)
    expect(screen.getByText(/from #5/i)).toBeInTheDocument()
    expect(screen.getByText(/get_weather/i)).toBeInTheDocument()
  })

  it("expands to reveal the args_json when the toggle button is clicked", async () => {
    const user = userEvent.setup()
    render(<ToolResultBackLink state="healthy" origin={healthyOrigin} />)
    expect(screen.queryByText(/"location":"SF"/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button"))
    expect(await screen.findByText(/"location":"SF"/)).toBeInTheDocument()
  })

  it("collapses again on a second click", async () => {
    const user = userEvent.setup()
    render(<ToolResultBackLink state="healthy" origin={healthyOrigin} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(await screen.findByText(/"location":"SF"/)).toBeInTheDocument()
    await user.click(btn)
    expect(screen.queryByText(/"location":"SF"/)).not.toBeInTheDocument()
  })

  it("renders the 'origin not captured' notice when state=orphan (no origin)", () => {
    render(<ToolResultBackLink state="orphan" origin={null} />)
    expect(screen.getByText(/origin not captured/i)).toBeInTheDocument()
    expect(document.querySelector(".lucide-triangle-alert")).not.toBeNull()
  })

  it("also falls back to the notice when state=healthy but origin is null", () => {
    render(<ToolResultBackLink state="healthy" origin={null} />)
    expect(screen.getByText(/origin not captured/i)).toBeInTheDocument()
  })

  it("applies the passed className", () => {
    const { container } = render(
      <ToolResultBackLink state="orphan" origin={null} className="my-class" />,
    )
    expect(container.querySelector(".my-class")).not.toBeNull()
  })
})
