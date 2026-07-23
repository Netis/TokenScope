import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"

import { SessionHeader } from "./session-header"
import { baseSessionDetail, NOW_MS } from "../../../test/fixtures"

describe("SessionHeader", () => {
  it("renders the agent badge and session id", () => {
    render(<SessionHeader detail={baseSessionDetail({ agent_kind: "claude-cli", session_id: "sess-1" })} />)
    expect(screen.getByText("claude-cli")).toBeInTheDocument()
    expect(screen.getByText("sess-1")).toBeInTheDocument()
  })

  it("renders the source id with the 'source:' label, falling back to '(default)' when empty", () => {
    const { rerender } = render(<SessionHeader detail={baseSessionDetail({ source_id: "src-1" })} />)
    expect(screen.getByText(/source: src-1/i)).toBeInTheDocument()
    rerender(<SessionHeader detail={baseSessionDetail({ source_id: "" })} />)
    expect(screen.getByText(/source: \(default\)/i)).toBeInTheDocument()
  })

  it("renders the turns/calls/tokens/cost/duration summary line", () => {
    render(
      <SessionHeader
        detail={baseSessionDetail({
          turn_count: 5,
          call_count: 12,
          total_input_tokens: 9000,
          total_output_tokens: 6000,
          total_cost_usd: 0.12,
          first_turn_at: NOW_MS - 3_600_000,
          last_turn_at: NOW_MS,
        })}
      />,
    )
    // duration is 1 hour = "1h 0m". tokens 9000+6000=15000 → "15.0K".
    expect(screen.getByText(/5 turns · 12 calls · 15\.0K tok/i)).toBeInTheDocument()
    expect(screen.getByText(/\$0\.12/i)).toBeInTheDocument()
    // 1h = 60*60*1000ms → 60 minutes → "1h 0m"
    expect(screen.getByText(/1h 0m/i)).toBeInTheDocument()
  })

  it("omits the cost portion when total_cost_usd is null", () => {
    render(<SessionHeader detail={baseSessionDetail({ total_cost_usd: null })} />)
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument()
  })

  it("renders zero turns/calls without throwing", () => {
    render(
      <SessionHeader
        detail={baseSessionDetail({
          turn_count: 0,
          call_count: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd: 0,
          first_turn_at: NOW_MS,
          last_turn_at: NOW_MS,
        })}
      />,
    )
    expect(screen.getByText(/0 turns · 0 calls/i)).toBeInTheDocument()
    // duration 0 → formatDuration returns "0ms".
    expect(screen.getByText(/0 turns · 0 calls · 0 tok · \$0\.00 · 0ms/i)).toBeInTheDocument()
  })
})
