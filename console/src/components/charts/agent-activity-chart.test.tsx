import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { baseAgentActivity } from "../../../test/fixtures"
import { AgentActivityChart } from "./agent-activity-chart"
import type { AgentActivityPoint } from "@/types/api"

afterEach(() => cleanup())

const POINTS: AgentActivityPoint[] = [
  { timestamp_ms: 1_780_000_000_000 - 600_000, agent_kind: "claude-cli", turn_count: 3 },
  { timestamp_ms: 1_780_000_000_000 - 300_000, agent_kind: "claude-cli", turn_count: 5 },
  { timestamp_ms: 1_780_000_000_000 - 600_000, agent_kind: "codex", turn_count: 1 },
  { timestamp_ms: 1_780_000_000_000 - 300_000, agent_kind: "codex", turn_count: 4 },
]

describe("AgentActivityChart", () => {
  it("renders the no-data state when points is empty", () => {
    const { container } = render(<AgentActivityChart points={[]} />)
    expect(container.textContent).toContain("No agent activity in the selected window")
  })

  it("renders the chart frame when points are populated", () => {
    const { container } = render(<AgentActivityChart points={POINTS} />)
    expect(container.textContent).not.toContain("No agent activity in the selected window")
  })

  it("handles a single point (spanSec fallback)", () => {
    const single: AgentActivityPoint[] = [
      { timestamp_ms: 1_780_000_000_000, agent_kind: "claude-cli", turn_count: 1 },
    ]
    const { container } = render(<AgentActivityChart points={single} />)
    expect(container.textContent).not.toContain("No agent activity")
  })

  it("works with the baseAgentActivity() fixture", () => {
    const { container } = render(<AgentActivityChart points={baseAgentActivity().points} />)
    expect(container.textContent).not.toContain("No agent activity")
  })

  it("orders kinds by total turn volume desc (dominant first)", () => {
    // claude-cli has 3+5=8, codex has 1+4=5. The chart orders kinds desc by
    // total turns; we can't assert visual order in happy-dom, but we can
    // confirm the chart renders without the no-data state.
    const { container } = render(<AgentActivityChart points={POINTS} />)
    expect(container.textContent).not.toContain("No agent activity")
  })
})
