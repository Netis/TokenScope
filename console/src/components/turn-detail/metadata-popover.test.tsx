import { describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MetadataPopover } from "./metadata-popover"
import { baseAgentTurnDetail } from "../../../test/fixtures"

describe("MetadataPopover", () => {
  it("renders all metadata rows with values from the turn", () => {
    const turn = baseAgentTurnDetail({
      turn_id: "turn-xyz",
      source_id: "src-1",
      session_id: "sess-1",
      agent_kind: "claude-cli",
      wire_api: "anthropic",
      models_used: ["claude-sonnet-4", "claude-haiku-3"],
      subagents_used: ["researcher"],
    })
    render(<MetadataPopover turn={turn} onClose={() => {}} />)
    expect(screen.getByText("Metadata")).toBeInTheDocument()
    // All labels present.
    for (const label of [
      "Trace ID",
      "Source",
      "Session ID",
      "Agent",
      "Wire API",
      "Start",
      "End",
      "Models",
      "Subagents",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // Values render (trace id is in the row title attr, plus the raw value text).
    expect(screen.getByText("turn-xyz")).toBeInTheDocument()
    expect(screen.getByText("claude-cli")).toBeInTheDocument()
    expect(screen.getByText("anthropic")).toBeInTheDocument()
    expect(screen.getByText("claude-sonnet-4, claude-haiku-3")).toBeInTheDocument()
    expect(screen.getByText("researcher")).toBeInTheDocument()
  })

  it("renders em-dash fallbacks for empty models / subagents", () => {
    const turn = baseAgentTurnDetail({ models_used: [], subagents_used: [] })
    render(<MetadataPopover turn={turn} onClose={() => {}} />)
    // Both rows collapse to "—" — find all em-dashes (≥2).
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2)
  })

  it("uses em-dash fallback when source_id is empty", () => {
    const turn = baseAgentTurnDetail({ source_id: "" })
    render(<MetadataPopover turn={turn} onClose={() => {}} />)
    // Source value collapses to "—". AllLabels present; assert one em-dash
    // specifically for the Source row by checking its title attribute.
    const sourceValue = screen.getAllByText("—")[0]
    expect(sourceValue).toBeInTheDocument()
    expect(sourceValue.getAttribute("title")).toBe("—")
  })

  it("invokes onClose when the X button is clicked", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<MetadataPopover turn={baseAgentTurnDetail()} onClose={onClose} />)
    // The X close button is inside the header row. Click the only button
    // in the header area (its aria-label is unset; locate by the X svg's parent).
    const closeBtn = screen.getByRole("button")
    await user.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
