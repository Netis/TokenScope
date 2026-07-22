import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CollapsibleSection } from "./collapsible-section"

// Sample component test exercising the harness end-to-end:
//   • happy-dom global DOM (the render target),
//   • @testing-library/react `render` / `screen` queries,
//   • @testing-library/jest-dom matchers (`toBeInTheDocument`),
//   • @testing-library/user-event `user.click` (a real DOM event under `act`),
//   • the `@/lib/utils` (cn) + `lucide-react` imports the component drags in
//     (proves bun resolves the `@/*` alias from the root tsconfig paths).
//
// See console/test/TESTING.md for how to write your own.

describe("CollapsibleSection", () => {
  it("renders the title and an optional count badge", () => {
    render(
      <CollapsibleSection title="Spans" count={3}>
        <p>body</p>
      </CollapsibleSection>,
    )
    // role=button comes from the <button> header; the title is its accessible name.
    expect(screen.getByRole("button", { name: /spans/i })).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("omits the count badge when count is not provided", () => {
    render(
      <CollapsibleSection title="Details">
        <p>body</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it("starts collapsed and reveals its children on click", async () => {
    const user = userEvent.setup()
    render(
      <CollapsibleSection title="Headers">
        <p>hidden-until-open</p>
      </CollapsibleSection>,
    )
    // closed by default → children absent from the DOM
    expect(screen.queryByText("hidden-until-open")).not.toBeInTheDocument()
    // expand
    await user.click(screen.getByRole("button", { name: /headers/i }))
    expect(await screen.findByText("hidden-until-open")).toBeInTheDocument()
  })

  it("starts expanded when defaultOpen is set and collapses on click", async () => {
    const user = userEvent.setup()
    render(
      <CollapsibleSection title="Trail" defaultOpen>
        <p>visible-up-front</p>
      </CollapsibleSection>,
    )
    expect(screen.getByText("visible-up-front")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /trail/i }))
    expect(screen.queryByText("visible-up-front")).not.toBeInTheDocument()
  })
})
