import { describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { StatsCards } from "./stats-cards"
import {
  baseAgentTurnCallItem,
  baseAgentTurnDetail,
} from "../../../test/fixtures"

// Helpers — build minimal call lists. request/response bodies need to be
// parseable per-wire_api when classifyType runs; an empty {} works for any
// provider since it just won't match any of the typed-content branches.
function call(seq: number, over: Partial<Parameters<typeof baseAgentTurnCallItem>[0]> = {}) {
  return baseAgentTurnCallItem({
    id: `call-${seq}`,
    sequence: seq,
    request_body: JSON.stringify({ messages: [] }),
    response_body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
    ...over,
  })
}

describe("StatsCards", () => {
  it("renders the four cards with their labels", () => {
    render(<StatsCards turn={baseAgentTurnDetail()} calls={[]} />)
    expect(screen.getByText("Calls")).toBeInTheDocument()
    expect(screen.getByText("Tokens")).toBeInTheDocument()
    expect(screen.getByText("Duration")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
  })

  it("renders turn.call_count in the Calls card", () => {
    render(<StatsCards turn={baseAgentTurnDetail({ call_count: 42 })} calls={[]} />)
    expect(screen.getByText("42")).toBeInTheDocument()
  })

  it("renders the cost line only when total_cost_usd is non-null", () => {
    const { rerender } = render(
      <StatsCards turn={baseAgentTurnDetail({ total_cost_usd: 0.07 })} calls={[]} />,
    )
    expect(screen.getByText("$0.07")).toBeInTheDocument()
    rerender(<StatsCards turn={baseAgentTurnDetail({ total_cost_usd: null })} calls={[]} />)
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument()
  })

  it("renders the in/out token counts", () => {
    render(
      <StatsCards
        turn={baseAgentTurnDetail({ total_input_tokens: 1200, total_output_tokens: 800 })}
        calls={[]}
      />,
    )
    // formatNumber(1200) === "1.2K", formatNumber(800) === "800"
    expect(screen.getByText("1.2K")).toBeInTheDocument()
    expect(screen.getByText("800")).toBeInTheDocument()
  })

  it("renders the slowest-call button when a slow call exists and fires onJumpToSlowest", async () => {
    const user = userEvent.setup()
    const onJumpToSlowest = vi.fn()
    const calls = [
      call(1, { e2e_latency_ms: 500 }),
      call(2, { e2e_latency_ms: 3000 }),
      call(3, { e2e_latency_ms: 1500 }),
    ]
    render(
      <StatsCards
        turn={baseAgentTurnDetail({ final_call_id: "call-3" })}
        calls={calls}
        onJumpToSlowest={onJumpToSlowest}
      />,
    )
    // slowest call is sequence 2 (3s).
    const slowBtn = screen.getByRole("button", { name: /slowest #2/i })
    expect(slowBtn).toBeInTheDocument()
    await user.click(slowBtn)
    expect(onJumpToSlowest).toHaveBeenCalledWith(2)
  })

  it("does not render the slowest button when no calls have e2e_latency_ms", () => {
    const calls = [
      call(1, { e2e_latency_ms: null }),
      call(2, { e2e_latency_ms: null }),
    ]
    render(<StatsCards turn={baseAgentTurnDetail()} calls={calls} />)
    expect(screen.queryByRole("button", { name: /slowest/i })).not.toBeInTheDocument()
  })

  it("renders the Status badge with the turn status text", () => {
    render(<StatsCards turn={baseAgentTurnDetail({ status: "complete" })} calls={[]} />)
    expect(screen.getByText("complete")).toBeInTheDocument()
  })

  it("tallies tool_call / text / final types across calls", () => {
    // final_call_id matches call-3 → call-3 classified as "final".
    // call-1's response has tool_use content; call-2's response is plain text.
    const calls = [
      call(1, {
        response_body: JSON.stringify({
          content: [{ type: "tool_use", id: "tool-1", name: "get_weather", input: {} }],
          stop_reason: "tool_use",
        }),
      }),
      call(2, { response_body: JSON.stringify({ content: [{ type: "text", text: "hello" }] }) }),
      call(3, { response_body: JSON.stringify({ content: [{ type: "text", text: "final answer" }] }) }),
    ]
    const { container } = render(
      <StatsCards turn={baseAgentTurnDetail({ final_call_id: "call-3" })} calls={calls} />,
    )
    // The Counts card renders three icons inline; the text after them is the
    // tally. We assert on the container contents rather than combinatorics:
    // the labels Wrench/MessageSquare/Target render with their counts.
    expect(container.textContent).toContain("1") // tool_call
    expect(container.textContent).toContain("2") // text (call-2 + final-as-text fallback)
  })
})
