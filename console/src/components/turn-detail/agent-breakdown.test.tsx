import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"

import { AgentBreakdown } from "./agent-breakdown"
import {
  baseAgentTurnCallItem,
  baseAgentTurnDetail,
} from "../../../test/fixtures"

describe("AgentBreakdown", () => {
  it("renders the topology pill and a sub-agent count for orchestrator topology", () => {
    const turn = baseAgentTurnDetail({
      agent_topology: "orchestrator",
      tool_surfaces: ["function_call", "mcp"],
      tool_call_total: 5,
      span_ids: ["call-1", "call-2"],
      suspicious_skills: [],
    })
    const calls = [
      baseAgentTurnCallItem({ id: "call-1", sequence: 1, agent_topology: "single_agent" }),
      baseAgentTurnCallItem({ id: "call-2", sequence: 2, agent_topology: "sub_agent" }),
      baseAgentTurnCallItem({ id: "call-3", sequence: 3, agent_topology: "sub_agent" }),
    ]
    render(<AgentBreakdown turn={turn} calls={calls} />)
    expect(screen.getByText("Agent breakdown")).toBeInTheDocument()
    expect(screen.getByText("orchestrator")).toBeInTheDocument()
    expect(screen.getByText(/2 sub-agents/i)).toBeInTheDocument()
    // Tool surfaces pills render.
    expect(screen.getByText("function")).toBeInTheDocument()
    expect(screen.getByText("mcp")).toBeInTheDocument()
    // Tool calls line: "5 total across 2 calls"
    expect(screen.getByText(/5 total across 2 calls/i)).toBeInTheDocument()
  })

  it("omits the sub-agent suffix when topology is single_agent", () => {
    const turn = baseAgentTurnDetail({ agent_topology: "single_agent" })
    render(<AgentBreakdown turn={turn} calls={[]} />)
    expect(screen.getByText("single")).toBeInTheDocument()
    expect(screen.queryByText(/sub-agent/i)).not.toBeInTheDocument()
  })

  it("renders an em-dash when topology is null", () => {
    const turn = baseAgentTurnDetail({ agent_topology: null })
    render(<AgentBreakdown turn={turn} calls={[]} />)
    // Find the row with topology label; the value is the em-dash.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("omits the sub-agent suffix when orchestrator has zero sub-agent calls", () => {
    const turn = baseAgentTurnDetail({ agent_topology: "orchestrator" })
    render(<AgentBreakdown turn={turn} calls={[]} />)
    expect(screen.queryByText(/sub-agent/i)).not.toBeInTheDocument()
  })

  it("renders 'none' when no tool surfaces", () => {
    const turn = baseAgentTurnDetail({ tool_surfaces: [] })
    render(<AgentBreakdown turn={turn} calls={[]} />)
    expect(screen.getByText("none")).toBeInTheDocument()
  })

  it("singularizes 'call' when only one span_id", () => {
    const turn = baseAgentTurnDetail({ tool_call_total: 1, span_ids: ["call-1"] })
    render(<AgentBreakdown turn={turn} calls={[]} />)
    expect(screen.getByText(/1 total across 1 call$/i)).toBeInTheDocument()
  })

  it("renders the Suspicious section only when suspicious_skills is non-empty", () => {
    const turn = baseAgentTurnDetail({
      suspicious_skills: [{ tool_name: "shell", reason: "shell is scary" }],
    })
    render(<AgentBreakdown turn={turn} calls={[]} />)
    expect(screen.getByText("Suspicious")).toBeInTheDocument()
    expect(screen.getByText("shell")).toBeInTheDocument()
    expect(screen.getByText("(shell is scary)")).toBeInTheDocument()
  })

  it("does not render the Suspicious section when empty", () => {
    const turn = baseAgentTurnDetail({ suspicious_skills: [] })
    render(<AgentBreakdown turn={turn} calls={[]} />)
    expect(screen.queryByText("Suspicious")).not.toBeInTheDocument()
  })
})
