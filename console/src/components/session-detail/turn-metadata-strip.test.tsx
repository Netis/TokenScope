import { describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TurnMetadataStrip } from "./turn-metadata-strip"
import { baseSessionTurnItem } from "../../../test/fixtures"

describe("TurnMetadataStrip", () => {
  it("renders the status badge and the duration/calls/tokens line", () => {
    render(<TurnMetadataStrip turn={baseSessionTurnItem({ status: "complete", duration_ms: 4200, call_count: 2, total_input_tokens: 2000, total_output_tokens: 1200 })} />)
    expect(screen.getByText("complete")).toBeInTheDocument()
    // 4200ms → "4.20s"; tokens in/out via formatNumber: 2.0K / 1.2K.
    expect(screen.getByText(/4\.20s · 2 calls · 2\.0K in \/ 1\.2K out/i)).toBeInTheDocument()
  })

  it("renders the 'View turn detail →' button when onInspect is provided", async () => {
    const user = userEvent.setup()
    const onInspect = vi.fn()
    render(
      <TurnMetadataStrip
        turn={baseSessionTurnItem({ turn_id: "turn-1" })}
        onInspect={onInspect}
      />,
    )
    await user.click(screen.getByText(/View turn detail →/i))
    expect(onInspect).toHaveBeenCalledWith("turn-1")
  })

  it("omits the 'View turn detail →' button when onInspect is undefined", () => {
    render(<TurnMetadataStrip turn={baseSessionTurnItem()} />)
    expect(screen.queryByText(/View turn detail →/i)).not.toBeInTheDocument()
  })
})
