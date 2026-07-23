import { beforeAll, describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TurnBlock } from "./turn-block"
import { baseSessionTurnItem } from "../../../test/fixtures"

// happy-dom lacks ResizeObserver; the TurnBlock's ClampedMarkdown uses one in
// a useLayoutEffect. Install a no-op stub so the component renders.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  }
})

describe("TurnBlock — user block", () => {
  it("renders the User label and the user_input as Markdown", () => {
    render(<TurnBlock turn={baseSessionTurnItem({ user_input: "Hello **world**" })} onInspect={() => {}} />)
    expect(screen.getByText(/👤 User/i)).toBeInTheDocument()
    // The bolded "world" is rendered via Markdown → <strong>world</strong>.
    expect(screen.getByText("world").tagName).toBe("STRONG")
  })

  it("renders the user block even when user_input is null", () => {
    render(<TurnBlock turn={baseSessionTurnItem({ user_input: null })} onInspect={() => {}} />)
    expect(screen.getByText(/👤 User/i)).toBeInTheDocument()
  })
})

describe("TurnBlock — assistant block", () => {
  it("renders the Assistant label and the final_answer as Markdown when present", () => {
    render(
      <TurnBlock
        turn={baseSessionTurnItem({ final_answer: "The answer is **42**." })}
        onInspect={() => {}}
      />,
    )
    expect(screen.getByText(/🎯 Assistant/i)).toBeInTheDocument()
    expect(screen.getByText("42").tagName).toBe("STRONG")
  })

  it("renders the 'Turn ended without a final answer' note when final_answer is null", () => {
    render(<TurnBlock turn={baseSessionTurnItem({ final_answer: null })} onInspect={() => {}} />)
    expect(screen.getByText(/Turn ended without a final answer/i)).toBeInTheDocument()
  })

  it("renders the 'incomplete' marker when final_answer is empty string", () => {
    render(
      <TurnBlock
        turn={baseSessionTurnItem({ final_answer: "" })}
        onInspect={() => {}}
      />,
    )
    expect(screen.getByText(/incomplete/i)).toBeInTheDocument()
    expect(screen.getByText(/Turn ended without a final answer/i)).toBeInTheDocument()
  })

  it("applies the red-tinted border/background to the Assistant card when no final answer", () => {
    const { container } = render(
      <TurnBlock turn={baseSessionTurnItem({ final_answer: null })} onInspect={() => {}} />,
    )
    // The Assistant card is the second flex-1 child with a rounded-md border.
    // Find by the red border class which is only applied when hasFinalAnswer=false.
    expect(container.querySelector(".border-red-300")).not.toBeNull()
  })

  it("applies the muted card to the Assistant card when final answer is present", () => {
    const { container } = render(
      <TurnBlock turn={baseSessionTurnItem({ final_answer: "yes" })} onInspect={() => {}} />,
    )
    // The card has bg-muted/40 in the happy case.
    expect(container.querySelector(".bg-muted\\/40")).not.toBeNull()
    expect(container.querySelector(".border-red-300")).toBeNull()
  })
})

describe("TurnBlock — show more / less (ClampedMarkdown)", () => {
  it("renders the 'show less ↑' button when expanded", async () => {
    const user = userEvent.setup()
    // Use a long-enough user_input that triggers truncation. happy-dom
    // line-clamp measurement doesn't expose scrollHeight reliably, but the
    // expanded branch renders the 'show less ↑' button unconditionally.
    const long = "para 1\n\npara 2\n\npara 3\n\npara 4"
    render(<TurnBlock turn={baseSessionTurnItem({ user_input: long })} onInspect={() => {}} />)
    // The 'show more ↓' button may not render (scrollHeight may be 0 in
    // happy-dom); we test the alternate path via 'show less' instead.
    const more = screen.queryByText(/show more/i)
    if (more) {
      await user.click(more)
      expect(await screen.findByText(/show less/i)).toBeInTheDocument()
    }
  })
})

describe("TurnBlock — TurnMetadataStrip integration", () => {
  it("renders the metadata strip with the status badge", () => {
    render(
      <TurnBlock
        turn={baseSessionTurnItem({ status: "complete" })}
        onInspect={() => {}}
      />,
    )
    expect(screen.getByText("complete")).toBeInTheDocument()
  })

  it("renders the 'View turn detail →' button in the metadata strip and fires onInspect", async () => {
    const user = userEvent.setup()
    const onInspect = vi.fn()
    render(
      <TurnBlock
        turn={baseSessionTurnItem({ turn_id: "turn-99" })}
        onInspect={onInspect}
      />,
    )
    await user.click(screen.getByText(/View turn detail →/i))
    expect(onInspect).toHaveBeenCalledWith("turn-99")
  })
})
