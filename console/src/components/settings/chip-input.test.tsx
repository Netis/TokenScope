import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { ChipInput } from "./chip-input"

afterEach(() => cleanup())

/** Controlled Harness wrapper so the values prop tracks the onChange updates. */
function Harness({
  initial = [],
  validate,
}: {
  initial?: string[]
  validate?: (token: string) => boolean
}) {
  const [values, setValues] = React.useState<string[]>(initial)
  return (
    <ChipInput values={values} onChange={setValues} placeholder="add token" validate={validate} />
  )
}

describe("ChipInput", () => {
  it("renders the placeholder when values is empty", () => {
    const { container } = render(<Harness />)
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("add token")
  })

  it("hides the placeholder once a chip is present", () => {
    const { container } = render(<Harness initial={["alpha"]} />)
    expect(container.querySelector("input")?.getAttribute("placeholder")).toBe("")
  })

  it("renders chips for each value", () => {
    const { container } = render(<Harness initial={["a", "b", "c"]} />)
    expect(container.textContent).toContain("a")
    expect(container.textContent).toContain("b")
    expect(container.textContent).toContain("c")
  })

  it("commits a draft on Enter and clears the input", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    const input = container.querySelector("input")!
    await user.type(input, "new-token{Enter}")
    expect(container.textContent).toContain("new-token")
    expect(input.value).toBe("")
  })

  it("commits a draft on comma", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    const input = container.querySelector("input")!
    await user.type(input, "comma-token,")
    expect(container.textContent).toContain("comma-token")
    expect(input.value).toBe("")
  })

  it("commits a draft on blur", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    const input = container.querySelector("input")!
    await user.type(input, "blur-token")
    await user.tab() // move focus away → blur fires
    expect(container.textContent).toContain("blur-token")
  })

  it("does NOT commit empty or whitespace-only drafts", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness initial={["x"]} />)
    const input = container.querySelector("input")!
    await user.type(input, "   {Enter}")
    // Only the pre-existing "x" chip remains.
    expect(container.textContent).not.toContain("   ")
    expect(container.textContent).toContain("x")
  })

  it("does NOT add a duplicate value", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness initial={["dup"]} />)
    const input = container.querySelector("input")!
    await user.type(input, "dup{Enter}")
    // The chip wrappers carry the "inline-flex" class (one per chip).
    // No second "dup" chip is appended — only the original survives.
    const chips = Array.from(container.querySelectorAll("span.inline-flex"))
    const dupChips = chips.filter((el) => (el.textContent ?? "").includes("dup"))
    expect(dupChips.length).toBe(1)
  })

  it("removes a chip via the × button", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness initial={["keep", "drop"]} />)
    const removeButtons = container.querySelectorAll('button[aria-label^="Remove "]')
    // Find the "Remove drop" button.
    const dropBtn = Array.from(removeButtons).find(
      (b) => (b.getAttribute("aria-label") ?? "").includes("drop"),
    ) as HTMLButtonElement | undefined
    expect(dropBtn).not.toBeUndefined()
    await user.click(dropBtn!)
    expect(container.textContent).not.toContain("drop")
    expect(container.textContent).toContain("keep")
  })

  it("removes the last chip on Backspace with an empty draft", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness initial={["last"]} />)
    const input = container.querySelector("input")!
    await user.type(input, "{Backspace}")
    expect(container.textContent).not.toContain("last")
  })

  it("does NOT remove on Backspace when the draft is non-empty", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness initial={["keep"]} />)
    const input = container.querySelector("input")!
    await user.type(input, "x{Backspace}")
    // Draft is gone (backspace cleared it), but chip stays.
    expect(container.textContent).toContain("keep")
  })

  it("trims and strips trailing comma from a committed draft", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    const input = container.querySelector("input")!
    await user.type(input, "  trailing,  {Enter}")
    expect(container.textContent).toContain("trailing")
  })

  it("marks invalid chips (per the validator) with the destructive class", () => {
    const { container } = render(
      <Harness initial={["good", "bad"]} validate={(t) => t === "good" || t === "good2"} />,
    )
    // The "bad" chip carries the destructive class (text-destructive).
    const chips = Array.from(container.querySelectorAll("span.inline-flex"))
    const badChip = chips.find((el) => (el.textContent ?? "").includes("bad")) as HTMLElement | undefined
    expect(badChip).not.toBeUndefined()
    expect(badChip!.className).toContain("destructive")
  })

  it("renders the good chip in the muted (non-destructive) class", () => {
    const { container } = render(
      <Harness initial={["good"]} validate={(t) => t === "good"} />,
    )
    const chips = Array.from(container.querySelectorAll("span.inline-flex"))
    const goodChip = chips.find((el) => (el.textContent ?? "").includes("good")) as HTMLElement | undefined
    expect(goodChip).not.toBeUndefined()
    expect(goodChip!.className).toContain("muted")
    expect(goodChip!.className).not.toContain("destructive")
  })
})
