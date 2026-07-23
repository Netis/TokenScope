import { describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RawHttpDrawer, type RawHttpData } from "./raw-http-drawer"

function data(over: Partial<RawHttpData> = {}): RawHttpData {
  return {
    request_path: "/v1/messages",
    status_code: 200,
    client_ip: "1.1.1.1",
    client_port: 5000,
    server_ip: "2.2.2.2",
    server_port: 8080,
    is_stream: true,
    e2e_latency_ms: 1500,
    request_time: 1_780_000_000_000,
    request_headers: JSON.stringify([["content-type", "application/json"]]),
    response_headers: JSON.stringify([["content-type", "text/event-stream"]]),
    request_body: JSON.stringify({ hello: "world" }),
    response_body: JSON.stringify({ ok: true }),
    ...over,
  }
}

describe("RawHttpDrawer", () => {
  it("renders nothing when data is null", () => {
    const { container } = render(<RawHttpDrawer data={null} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the title and the request line", () => {
    render(<RawHttpDrawer data={data()} onClose={() => {}} />)
    expect(screen.getByText("Raw HTTP")).toBeInTheDocument()
    expect(screen.getByText("POST")).toBeInTheDocument()
    expect(screen.getByText("/v1/messages")).toBeInTheDocument()
  })

  it("renders the status badge from status_code", () => {
    render(<RawHttpDrawer data={data({ status_code: 200 })} onClose={() => {}} />)
    expect(screen.getByText("200")).toBeInTheDocument()
  })

  it("renders the 5-tuple line with stream/non-stream + latency + request_time", () => {
    render(
      <RawHttpDrawer
        data={data({
          client_ip: "1.1.1.1",
          client_port: 5000,
          server_ip: "2.2.2.2",
          server_port: 8080,
          is_stream: true,
          e2e_latency_ms: 1500,
          request_time: 1_780_000_000_000,
          // Avoid event-stream response_headers so the only /stream/ match
          // is the one in the request-line div.
          response_headers: JSON.stringify([["content-type", "application/json"]]),
        })}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByText(/1\.1\.1\.1:5000 → 2\.2\.2\.2:8080/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/stream/i)).toBeInTheDocument()
    expect(screen.getByText(/1\.50s/i)).toBeInTheDocument()
  })

  it("renders 'non-stream' for non-streaming requests", () => {
    render(
      <RawHttpDrawer
        data={data({
          is_stream: false,
          // Drop event-stream from headers so only the non-stream word matches.
          response_headers: JSON.stringify([["content-type", "application/json"]]),
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/non-stream/i)).toBeInTheDocument()
  })

  it("renders the header tables with parsed request/response headers", () => {
    render(<RawHttpDrawer data={data()} onClose={() => {}} />)
    // Both header tables render the header names.
    expect(screen.getByText("Request Headers")).toBeInTheDocument()
    expect(screen.getByText("Response Headers")).toBeInTheDocument()
    expect(screen.getAllByText("content-type").length).toBe(2)
    expect(screen.getByText("application/json")).toBeInTheDocument()
    expect(screen.getByText("text/event-stream")).toBeInTheDocument()
  })

  it("renders the 'No headers' notice when headers are null", () => {
    render(
      <RawHttpDrawer
        data={data({ request_headers: null, response_headers: null })}
        onClose={() => {}}
      />,
    )
    expect(screen.getAllByText(/no headers/i).length).toBe(2)
  })

  it("invokes onClose when the X close button is clicked", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<RawHttpDrawer data={data()} onClose={onClose} />)
    // The close button is the X svg in the header. The drawer header has the
    // Raw HTTP title and a button with the X icon. Click it.
    const btns = screen.getAllByRole("button")
    // The X close button is the first button in the header row (before any
    // CollapsibleSection toggles).
    await user.click(btns[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("invokes onClose when the backdrop is clicked", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(<RawHttpDrawer data={data()} onClose={onClose} />)
    // The backdrop is the first fixed-position div with bg-black/40.
    const backdrop = container.querySelector(".bg-black\\/40") as Element
    expect(backdrop).toBeDefined()
    await user.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders the BodyViewer sections (Request Body / Response Body)", () => {
    render(<RawHttpDrawer data={data()} onClose={() => {}} />)
    expect(screen.getByText("Request Body")).toBeInTheDocument()
    expect(screen.getByText("Response Body")).toBeInTheDocument()
  })
})
