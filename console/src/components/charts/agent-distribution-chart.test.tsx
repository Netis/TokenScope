import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { AgentDistributionChart } from "./agent-distribution-chart"
import type { AgentKindSummary } from "@/types/api"

afterEach(() => cleanup())

const ROWS: AgentKindSummary[] = [
  {
    agent_kind: "claude-cli",
    turn_count: 12,
    total_input_tokens: 9000,
    total_output_tokens: 6000,
    avg_duration_ms: 4200,
    last_seen_ms: 1_780_000_000_000,
  },
  {
    agent_kind: "codex",
    turn_count: 8,
    total_input_tokens: 4000,
    total_output_tokens: 2000,
    avg_duration_ms: 3000,
    last_seen_ms: 1_780_000_000_000,
  },
]

describe("AgentDistributionChart", () => {
  it("renders the no-data state when rows is empty", () => {
    const { container } = render(<AgentDistributionChart rows={[]} />)
    expect(container.textContent).toContain("No agents observed in the selected window")
  })

  it("renders the chart frame when rows are populated", () => {
    const { container } = render(<AgentDistributionChart rows={ROWS} />)
    expect(container.textContent).not.toContain("No agents observed")
  })

  it("truncates long agent_kind labels in chart data", () => {
    const longKind: AgentKindSummary[] = [
      {
        agent_kind: "this-is-a-very-long-agent-kind-name-that-exceeds-24-chars",
        turn_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        avg_duration_ms: 0,
        last_seen_ms: 0,
      },
    ]
    const { container } = render(<AgentDistributionChart rows={longKind} />)
    expect(container.textContent).not.toContain("No agents observed")
  })

  it("trims to top 10 by turn_count desc", () => {
    const many: AgentKindSummary[] = Array.from({ length: 15 }, (_, i) => ({
      agent_kind: `kind-${i}`,
      turn_count: 100 - i,
      total_input_tokens: 0,
      total_output_tokens: 0,
      avg_duration_ms: null,
      last_seen_ms: 0,
    }))
    const { container } = render(<AgentDistributionChart rows={many} />)
    expect(container.textContent).not.toContain("No agents observed")
  })
})
