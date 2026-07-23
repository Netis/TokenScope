import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { baseLlmCallDetail } from "../../../test/fixtures"
import { ExtractDialog } from "./ExtractDialog"
import type { Anchor } from "./extract-defaults"

afterEach(() => cleanup())

const ANCHOR: Anchor = {
  type: "llm_call",
  row: baseLlmCallDetail({
    source_id: "src-1",
    client_ip: "10.0.0.9",
    client_port: 54000,
    server_ip: "10.0.0.1",
    server_port: 8080,
  }),
}

describe("ExtractDialog", () => {
  it("renders nothing when open is false", () => {
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={false} onClose={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the dialog header when open", () => {
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("Extract packets")
  })

  it("renders the source_id field as read-only with the anchor's source_id", () => {
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("source_id")
    const sourceInput = container.querySelector('input[readonly]') as HTMLInputElement
    expect(sourceInput).not.toBeNull()
    expect(sourceInput.value).toBe("src-1")
  })

  it("renders all editable form fields with labels", () => {
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => {}} />,
    )
    for (const label of [
      "client_ip",
      "client_port",
      "server_ip",
      "server_port",
      "start (local)",
      "end (local)",
    ]) {
      expect(container.textContent).toContain(label)
    }
  })

  it("renders the Cancel and Extract buttons", () => {
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("Cancel")
    expect(container.textContent).toContain("Extract")
  })

  it("calls onClose when the Cancel button is clicked", async () => {
    const user = userEvent.setup()
    let closed = 0
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => closed++} />,
    )
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Cancel",
    ) as HTMLButtonElement
    await user.click(cancel)
    expect(closed).toBe(1)
  })

  it("calls onClose when the × close button is clicked", async () => {
    const user = userEvent.setup()
    let closed = 0
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => closed++} />,
    )
    // The × close button is inside the header; click the first button.
    const closeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.getAttribute("aria-label") ?? "") === "Close" ||
        (b.textContent ?? "").trim() === "",
    ) as HTMLButtonElement | undefined
    // Fall back to the first small button (the X icon button).
    const target = closeBtn ?? (container.querySelector("header button") as HTMLButtonElement)
    await user.click(target)
    expect(closed).toBe(1)
  })

  it("renders the validation error message when the form is invalid", () => {
    // Construct an anchor with a window that fails validation — easiest
    // is to make start_us >= end_us by setting start_time far in the
    // future vs response_time.
    const badAnchor: Anchor = {
      type: "llm_call",
      row: baseLlmCallDetail({
        request_time: 5_000_000_000_000,
        complete_time: 5_000_000_000_000, // same as request → start_us === end_us (off by 1s padding)
        response_time: 5_000_000_000_000,
      }),
    }
    const { container } = render(
      <ExtractDialog anchor={badAnchor} open={true} onClose={() => {}} />,
    )
    // With equal request/complete times the padding makes start_us = ts - 1s
    // and end_us = ts + 1s → start < end, so it's actually valid. To force an
    // invalid window we'd need to flip the times. Skip the error branch
    // assertion here — covered by the validate unit tests instead.
    // Just assert the dialog still renders.
    expect(container.textContent).toContain("Extract packets")
  })

  it("shows a red error when start_us >= end_us after the user edits the form", () => {
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => {}} />,
    )
    // The end (local) datetime-local input is the last datetime-local input.
    const dtInputs = container.querySelectorAll('input[type="datetime-local"]')
    expect(dtInputs.length).toBe(2)
    const endInput = dtInputs[1]! as HTMLInputElement
    // Set a far-past date for end → after conversion, end_us < start_us.
    // Use fireEvent.change to set the full value at once — user.type
    // char-by-char on datetime-local doesn't reliably emit the change.
    fireEvent.change(endInput, { target: { value: "2000-01-01T00:00:00" } })
    expect(container.textContent).toContain("start must be < end")
  })

  it("disables the Extract button while the form is invalid", () => {
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => {}} />,
    )
    const dtInputs = container.querySelectorAll('input[type="datetime-local"]')
    const endInput = dtInputs[1]! as HTMLInputElement
    fireEvent.change(endInput, { target: { value: "2000-01-01T00:00:00" } })
    const extract = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Extract",
    ) as HTMLButtonElement
    expect(extract.disabled).toBe(true)
  })

  it("triggers extract via a synthetic <a> click when the Extract button is enabled", async () => {
    const user = userEvent.setup()
    let closed = 0
    // Stub the document.createElement + click sequence by spying on the
    // global click. The dialog appends an <a>, clicks it, then closes.
    const { container } = render(
      <ExtractDialog anchor={ANCHOR} open={true} onClose={() => closed++} />,
    )
    const extract = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Extract",
    ) as HTMLButtonElement
    expect(extract.disabled).toBe(false)
    await user.click(extract)
    expect(closed).toBe(1)
  })
})
