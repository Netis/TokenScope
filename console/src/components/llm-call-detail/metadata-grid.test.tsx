import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"

import { MetadataGrid } from "./metadata-grid"
import { baseLlmCallDetail } from "../../../test/fixtures"

describe("MetadataGrid", () => {
  it("renders the basic rows for a passive-tap call (no process)", () => {
    const detail = baseLlmCallDetail({
      id: "call-1",
      source_id: "src-1",
      response_id: "resp_1",
      request_path: "/v1/messages",
      client_ip: "1.1.1.1",
      client_port: 5000,
      server_ip: "2.2.2.2",
      server_port: 8080,
      is_stream: true,
      api_type: "anthropic",
      process: null,
    })
    render(<MetadataGrid detail={detail} />)
    for (const label of ["ID", "Source", "Response ID", "Path", "Client", "Server", "Stream", "API Type"]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText("call-1")).toBeInTheDocument()
    expect(screen.getByText("src-1")).toBeInTheDocument()
    expect(screen.getByText("resp_1")).toBeInTheDocument()
    expect(screen.getByText("/v1/messages")).toBeInTheDocument()
    expect(screen.getByText("1.1.1.1:5000")).toBeInTheDocument()
    expect(screen.getByText("2.2.2.2:8080")).toBeInTheDocument()
    expect(screen.getByText("Yes")).toBeInTheDocument()
    expect(screen.getByText("anthropic")).toBeInTheDocument()
  })

  it("shows 'No' for a non-streaming call", () => {
    render(<MetadataGrid detail={baseLlmCallDetail({ is_stream: false })} />)
    expect(screen.getByText("No")).toBeInTheDocument()
  })

  it("falls back to em-dash when source_id is empty", () => {
    render(<MetadataGrid detail={baseLlmCallDetail({ source_id: "" })} />)
    // The Source row's value collapses to "—".
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1)
  })

  it("falls back to em-dash when response_id is null", () => {
    render(<MetadataGrid detail={baseLlmCallDetail({ response_id: null })} />)
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1)
  })

  it("renders the Process row when process is set, including pid", () => {
    render(
      <MetadataGrid
        detail={baseLlmCallDetail({
          process: { pid: 4242, comm: "python3", exe: "/usr/bin/python3" },
        })}
      />,
    )
    expect(screen.getByText("Process")).toBeInTheDocument()
    expect(screen.getByText("python3 (pid 4242)")).toBeInTheDocument()
    expect(screen.getByText("Executable")).toBeInTheDocument()
    expect(screen.getByText("/usr/bin/python3")).toBeInTheDocument()
  })

  it("omits the Executable row when process.exe is null", () => {
    render(
      <MetadataGrid
        detail={baseLlmCallDetail({
          process: { pid: 4242, comm: "python3", exe: null },
        })}
      />,
    )
    expect(screen.getByText("Process")).toBeInTheDocument()
    expect(screen.queryByText("Executable")).not.toBeInTheDocument()
  })
})
