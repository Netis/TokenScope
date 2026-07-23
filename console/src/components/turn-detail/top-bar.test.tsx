import { describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TopBar } from "./top-bar"
import { baseAgentTurnDetail } from "../../../test/fixtures"

describe("TopBar", () => {
  it("renders the header title and truncated turn id", () => {
    const turn = baseAgentTurnDetail({ agent_kind: "claude-cli", turn_id: "abcdef0123456789" })
    render(<TopBar turn={turn} onClose={() => {}} />)
    expect(screen.getByText("Agent Trace Detail")).toBeInTheDocument()
    expect(screen.getByText("claude-cli")).toBeInTheDocument()
    // turn_id is truncated: head 8 chars + ellipsis + tail 6 chars.
    const idNode = screen.getByTitle("abcdef0123456789")
    expect(idNode.textContent).toBe("abcdef01…456789")
  })

  it("renders the full id when short enough to skip truncation", () => {
    const turn = baseAgentTurnDetail({ turn_id: "turn-1" })
    render(<TopBar turn={turn} onClose={() => {}} />)
    const idNode = screen.getByTitle("turn-1")
    expect(idNode.textContent).toBe("turn-1")
  })

  it("invokes onClose when the X close button is clicked", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<TopBar turn={baseAgentTurnDetail()} onClose={onClose} />)
    // The X (lucide X) close is the last button; click by aria-label, which
    // is "Show metadata" for the Info button — the other button has no
    // aria-label, so find via the X svg's parent button.
    const buttons = screen.getAllByRole("button")
    // The X close button is the last button in the row.
    const closeBtn = buttons[buttons.length - 1]
    await user.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("toggles the metadata popover open and closed via the Info button", async () => {
    const user = userEvent.setup()
    const turn = baseAgentTurnDetail({
      metadata: { proxy: { role: "proxy_in", peer_turn_ids: ["peer-1"] } },
    })
    render(<TopBar turn={turn} onClose={() => {}} />)
    // Initially the popover is closed (no Metadata header rendered).
    expect(screen.queryByText("Metadata")).not.toBeInTheDocument()
    // Click the Info button (aria-label "Show metadata").
    await user.click(screen.getByRole("button", { name: /show metadata/i }))
    expect(await screen.findByText("Metadata")).toBeInTheDocument()
  })

  it("renders the ExtractPacketsButton with a visible label", () => {
    render(<TopBar turn={baseAgentTurnDetail()} onClose={() => {}} />)
    expect(screen.getByText(/extract packets/i)).toBeInTheDocument()
  })
})
