import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"

import { SummaryCards } from "./summary-cards"
import { baseLlmCallDetail } from "../../../test/fixtures"

describe("SummaryCards", () => {
  it("renders the four cards with their labels", () => {
    render(<SummaryCards detail={baseLlmCallDetail()} />)
    expect(screen.getByText("Wire API / Model")).toBeInTheDocument()
    expect(screen.getByText("Status / Finish")).toBeInTheDocument()
    // For a streaming call, the TTFT/E2E label is used.
    expect(screen.getByText("TTFT / E2E")).toBeInTheDocument()
    expect(screen.getByText("Tokens")).toBeInTheDocument()
  })

  it("uses 'TTFB / E2E' for non-streaming calls", () => {
    render(<SummaryCards detail={baseLlmCallDetail({ is_stream: false })} />)
    expect(screen.getByText("TTFB / E2E")).toBeInTheDocument()
  })

  it("renders wire_api and the model", () => {
    render(<SummaryCards detail={baseLlmCallDetail({ wire_api: "anthropic", model: "claude-sonnet-4" })} />)
    expect(screen.getByText("anthropic")).toBeInTheDocument()
    expect(screen.getByText("claude-sonnet-4")).toBeInTheDocument()
  })

  it("renders the status badge and finish badge", () => {
    render(<SummaryCards detail={baseLlmCallDetail({ status_code: 200, finish_reason: "end_turn" })} />)
    expect(screen.getByText("200")).toBeInTheDocument()
    expect(screen.getByText("end_turn")).toBeInTheDocument()
  })

  it("renders 'Tokens (estimated)' label when tokens_estimated is true", () => {
    render(<SummaryCards detail={baseLlmCallDetail({ tokens_estimated: true })} />)
    expect(screen.getByText("Tokens (estimated)")).toBeInTheDocument()
  })

  it("renders the '~' prefix on tokens when estimated", () => {
    const { container } = render(
      <SummaryCards
        detail={baseLlmCallDetail({ tokens_estimated: true, input_tokens: 100, output_tokens: 50, total_tokens: 150 })}
      />,
    )
    // The token span has the '~' prefixes via text nodes. Check the in/out text.
    // The total line: "total: ~150".
    expect(container.textContent).toContain("~100")
    expect(container.textContent).toContain("~50")
    expect(container.textContent).toContain("~150")
  })

  it("renders TTFT and E2E values via formatMs", () => {
    render(
      <SummaryCards
        detail={baseLlmCallDetail({ ttft_ms: 300, e2e_latency_ms: 2100, is_stream: true })}
      />,
    )
    expect(screen.getByText("300.0ms")).toBeInTheDocument()
    expect(screen.getByText("2.10s")).toBeInTheDocument()
  })

  it("renders an em dash when ttft_ms is null", () => {
    render(<SummaryCards detail={baseLlmCallDetail({ ttft_ms: null })} />)
    // The TTFT value is "—" (em dash). It may appear multiple times (TTFT
    // label has it twice — once in the card title, once in the timeline).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("renders the input/output token counts", () => {
    render(
      <SummaryCards
        detail={baseLlmCallDetail({ input_tokens: 1200, output_tokens: 800 })}
      />,
    )
    // 1200 → "1.2K", 800 → "800".
    expect(screen.getByText("1.2K")).toBeInTheDocument()
    expect(screen.getByText("800")).toBeInTheDocument()
  })

  it("renders the total token line", () => {
    render(
      <SummaryCards
        detail={baseLlmCallDetail({ total_tokens: 2000 })}
      />,
    )
    expect(screen.getByText(/total: 2\.0K/i)).toBeInTheDocument()
  })
})
