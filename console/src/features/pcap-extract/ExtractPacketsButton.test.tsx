import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { baseLlmCallDetail } from "../../../test/fixtures"
import { ExtractPacketsButton } from "./ExtractPacketsButton"
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

describe("ExtractPacketsButton", () => {
  it("renders the button with the default label and Download icon", () => {
    const { container } = render(<ExtractPacketsButton anchor={ANCHOR} />)
    expect(container.textContent).toContain("Extract packets")
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("opens the dialog when the button is clicked", async () => {
    const user = userEvent.setup()
    const { container } = render(<ExtractPacketsButton anchor={ANCHOR} />)
    // Initially the dialog is closed → no "source_id" label rendered.
    expect(container.textContent).not.toContain("source_id")
    const button = container.querySelector("button") as HTMLButtonElement
    await user.click(button)
    // Now the dialog header + form render.
    expect(container.textContent).toContain("Extract packets")
    expect(container.textContent).toContain("source_id")
  })

  it("closes the dialog when the Cancel button is clicked", async () => {
    const user = userEvent.setup()
    const { container } = render(<ExtractPacketsButton anchor={ANCHOR} />)
    const button = container.querySelector("button") as HTMLButtonElement
    await user.click(button)
    expect(container.textContent).toContain("source_id")
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Cancel",
    ) as HTMLButtonElement
    await user.click(cancel)
    // Dialog closed → source_id label gone.
    expect(container.textContent).not.toContain("source_id")
  })

  it("applies the default className when none is given", () => {
    const { container } = render(<ExtractPacketsButton anchor={ANCHOR} />)
    const button = container.querySelector("button") as HTMLButtonElement
    // The default class set includes "border" and "rounded-md".
    expect(button.className).toContain("border")
    expect(button.className).toContain("rounded-md")
  })

  it("applies a custom className when one is passed", () => {
    const { container } = render(
      <ExtractPacketsButton anchor={ANCHOR} className="custom-class" />,
    )
    const button = container.querySelector("button") as HTMLButtonElement
    expect(button.className).toContain("custom-class")
    // The default class is NOT applied when className is provided.
    expect(button.className).not.toContain("border")
  })

  it("renders the title attribute on the button", () => {
    const { container } = render(<ExtractPacketsButton anchor={ANCHOR} />)
    const button = container.querySelector("button") as HTMLButtonElement
    expect(button.getAttribute("title")).toContain("Extract pcap packets")
  })

  it("opens the dialog for an http_exchange anchor type", async () => {
    const user = userEvent.setup()
    const httpAnchor: Anchor = {
      type: "http_exchange",
      row: {
        ...baseLlmCallDetail(),
        id: "ex-1",
        // HttpExchangeDetail has additional fields not present on
        // LlmCallDetail; supply the minimum the dialog reads via
        // defaultsFor(http_exchange).
        method: "POST",
        uri: "/v1/chat/completions",
        status: 200,
        is_sse: true,
        duration_ms: 2100,
        source_id: "src-2",
        client_ip: "10.0.0.10",
        client_port: 55000,
        server_ip: "10.0.0.2",
        server_port: 9000,
        request_time: 1_000_000,
        response_first_byte_time: 1_000_000 + 300,
        response_complete_time: 1_000_000 + 2100,
      } as unknown as Anchor extends { type: "http_exchange"; row: infer R } ? R : never,
    }
    const { container } = render(<ExtractPacketsButton anchor={httpAnchor} />)
    const button = container.querySelector("button") as HTMLButtonElement
    await user.click(button)
    expect(container.textContent).toContain("source_id")
    // The read-only source_id input carries the http_exchange defaults.
    const sourceInput = container.querySelector('input[readonly]') as HTMLInputElement
    expect(sourceInput).not.toBeNull()
    expect(sourceInput.value).toBe("src-2")
  })
})
