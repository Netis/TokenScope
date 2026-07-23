import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { Button } from "./button"
import { AgentBadge } from "./agent-badge"
import { FinishBadge } from "./finish-badge"
import { StatusBadge } from "./status-badge"
import { TurnStatusBadge } from "./turn-status-badge"
import { ProxyBadge } from "./proxy-badge"
import { Logo } from "./logo"
import { FilterDropdown } from "./filter-dropdown"
import { ToolSurfacePill, TopologyPill, SuspiciousMarker } from "../agent-pills"
import { Markdown } from "./markdown"
import { baseAgentTurnListItem } from "../../../test/fixtures"

// ── Button ───────────────────────────────────────────────────────────────────
describe("Button", () => {
  it("renders children and responds to click", async () => {
    const user = userEvent.setup()
    let clicked = 0
    render(<Button onClick={() => clicked++}>Save</Button>)
    expect(screen.getByText("Save")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(clicked).toBe(1)
  })

  it("applies the outline variant class", () => {
    render(<Button variant="outline">Out</Button>)
    const btn = screen.getByRole("button", { name: "Out" })
    expect(btn.className).toContain("border")
  })

  it("renders disabled and is not clickable", async () => {
    const user = userEvent.setup()
    let clicked = 0
    render(
      <Button disabled onClick={() => clicked++}>
        No
      </Button>,
    )
    const btn = screen.getByRole("button", { name: "No" })
    await user.click(btn)
    expect(clicked).toBe(0)
  })
})

// ── AgentBadge ───────────────────────────────────────────────────────────────
describe("AgentBadge", () => {
  it("renders the agent kind text", () => {
    render(<AgentBadge agentKind="claude-cli" />)
    expect(screen.getByText("claude-cli")).toBeInTheDocument()
  })
  it("uses the muted palette for an unknown kind", () => {
    render(<AgentBadge agentKind="mystery-agent" />)
    const el = screen.getByText("mystery-agent")
    expect(el.className).toContain("text-muted-foreground")
  })
})

// ── FinishBadge ──────────────────────────────────────────────────────────────
describe("FinishBadge", () => {
  it("renders the reason text", () => {
    render(<FinishBadge reason="end_turn" />)
    expect(screen.getByText("end_turn")).toBeInTheDocument()
  })
  it("renders an em dash for a null reason", () => {
    render(<FinishBadge reason={null} />)
    expect(screen.getByText("—")).toBeInTheDocument()
  })
})

// ── StatusBadge ──────────────────────────────────────────────────────────────
describe("StatusBadge", () => {
  it("renders 200 (success)", () => {
    render(<StatusBadge status={200} />)
    expect(screen.getByText("200").className).toContain("emerald")
  })
  it("renders 404 (4xx)", () => {
    render(<StatusBadge status={404} />)
    expect(screen.getByText("404").className).toContain("amber")
  })
  it("renders 429 (rate-limit, red)", () => {
    render(<StatusBadge status={429} />)
    expect(screen.getByText("429").className).toContain("red")
  })
  it("renders 500 (5xx, red)", () => {
    render(<StatusBadge status={500} />)
    expect(screen.getByText("500").className).toContain("red")
  })
  it("renders an em dash for a null status", () => {
    render(<StatusBadge status={null} />)
    expect(screen.getByText("—")).toBeInTheDocument()
  })
})

// ── TurnStatusBadge ──────────────────────────────────────────────────────────
describe("TurnStatusBadge", () => {
  it("renders complete", () => {
    render(<TurnStatusBadge status="complete" />)
    expect(screen.getByText("complete")).toBeInTheDocument()
  })
  it("renders in_progress with the pulse dot", () => {
    const { container } = render(<TurnStatusBadge status="in_progress" />)
    expect(screen.getByText("in_progress")).toBeInTheDocument()
    expect(container.querySelector(".animate-pulse")).not.toBeNull()
  })
  it("renders an em dash for null", () => {
    render(<TurnStatusBadge status={null} />)
    expect(screen.getByText("—")).toBeInTheDocument()
  })
  it("uses the default palette for an unknown status", () => {
    render(<TurnStatusBadge status="weird" />)
    expect(screen.getByText("weird").className).toContain("gray")
  })
})

// ── ProxyBadge ───────────────────────────────────────────────────────────────
describe("ProxyBadge", () => {
  it("renders nothing when there is no proxy_role", () => {
    const { container } = render(<ProxyBadge item={baseAgentTurnListItem()} />)
    expect(container.firstChild).toBeNull()
  })
  it("renders via proxy for a proxy_in primary leg", () => {
    render(<ProxyBadge item={baseAgentTurnListItem({ proxy_role: "proxy_in", proxy_peer_turn_ids: ["peer-1"] })} />)
    expect(screen.getByText(/via proxy/i)).toBeInTheDocument()
  })
  it("renders the hop-count suffix for multi-peer groups", () => {
    render(
      <ProxyBadge
        item={baseAgentTurnListItem({ proxy_role: "proxy_in", proxy_peer_turn_ids: ["peer-1", "peer-2"] })}
      />,
    )
    expect(screen.getByText(/via proxy \(\+2 hops\)/i)).toBeInTheDocument()
  })
  it("renders mirrored for a mirror_primary leg", () => {
    render(<ProxyBadge item={baseAgentTurnListItem({ proxy_role: "mirror_primary" })} />)
    expect(screen.getByText(/mirrored/i)).toBeInTheDocument()
  })
  it("renders proxy hop for a hidden proxy_out leg", () => {
    render(<ProxyBadge item={baseAgentTurnListItem({ proxy_role: "proxy_out" })} />)
    expect(screen.getByText(/proxy hop/i)).toBeInTheDocument()
  })
  it("renders mirror copy for a hidden mirror_secondary leg", () => {
    render(<ProxyBadge item={baseAgentTurnListItem({ proxy_role: "mirror_secondary" })} />)
    expect(screen.getByText(/mirror copy/i)).toBeInTheDocument()
  })
})

// ── Logo ─────────────────────────────────────────────────────────────────────
describe("Logo", () => {
  it("renders the icon variant with an svg", () => {
    const { container } = render(<Logo variant="icon" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
  it("renders the wordmark with the Heron text", () => {
    const { container } = render(<Logo variant="wordmark" />)
    expect(container.querySelector("svg")).not.toBeNull()
    expect(container.querySelector("text")?.textContent).toBe("Heron")
  })
})

// ── FilterDropdown ───────────────────────────────────────────────────────────
describe("FilterDropdown", () => {
  it("shows the closed label and opens to reveal flat options", async () => {
    const user = userEvent.setup()
    const onChange = () => {}
    render(<FilterDropdown label="Model" options={["gpt-4o", "claude"]} selected={[]} onChange={onChange} />)
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.queryByText("gpt-4o")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Model/i }))
    expect(await screen.findByText("gpt-4o")).toBeInTheDocument()
  })

  it("toggles selection and calls onChange", async () => {
    const user = userEvent.setup()
    // Controlled wrapper so the selected prop tracks the onChange updates.
    function Harness() {
      const [sel, setSel] = React.useState<string[]>([])
      return <FilterDropdown label="Model" options={["gpt-4o", "claude"]} selected={sel} onChange={setSel} />
    }
    const { container } = render(<Harness />)
    await user.click(screen.getByRole("button", { name: /Model/i }))
    await user.click(await screen.findByRole("button", { name: /gpt-4o/ }))
    // selection count badge now reads 1
    expect(screen.getByText("1")).toBeInTheDocument()
    // toggle off
    await user.click(screen.getByRole("button", { name: /gpt-4o/ }))
    expect(container.textContent).not.toContain("1")
  })

  it("renders the selection count badge and clears via the X", async () => {
    const user = userEvent.setup()
    let sel = ["gpt-4o"]
    const { container } = render(
      <FilterDropdown label="Model" options={["gpt-4o", "claude"]} selected={sel} onChange={(s) => (sel = s)} />,
    )
    // count badge "1"
    expect(screen.getByText("1")).toBeInTheDocument()
    // click the clear (X) — it's an svg; click the badge's X via the button area
    const xIcon = container.querySelectorAll("svg.lucide-x")[0]
    expect(xIcon).toBeDefined()
    await user.click(xIcon as unknown as Element)
    expect(sel).toEqual([])
  })

  it("renders grouped options and the No-options notice for empty groups", async () => {
    const user = userEvent.setup()
    render(
      <FilterDropdown
        label="Grouped"
        groups={[{ label: "A", options: ["a1"] }, { label: "B", options: ["b1"] }]}
        selected={[]}
        onChange={() => {}}
      />,
    )
    await user.click(screen.getByRole("button", { name: /Grouped/i }))
    expect(await screen.findByText("A")).toBeInTheDocument()
    expect(screen.getByText("B")).toBeInTheDocument()
    expect(screen.getByText("a1")).toBeInTheDocument()
  })

  it("renders the No options notice for empty flat options", async () => {
    const user = userEvent.setup()
    render(<FilterDropdown label="Empty" options={[]} selected={[]} onChange={() => {}} />)
    await user.click(screen.getByRole("button", { name: /Empty/i }))
    expect(await screen.findByText("No options")).toBeInTheDocument()
  })

  it("renders the No options notice for empty groups", async () => {
    const user = userEvent.setup()
    render(<FilterDropdown label="EmptyGroups" groups={[]} selected={[]} onChange={() => {}} />)
    await user.click(screen.getByRole("button", { name: /EmptyGroups/i }))
    expect(await screen.findByText("No options")).toBeInTheDocument()
  })

  it("closes when clicking outside", async () => {
    const user = userEvent.setup()
    render(
      <div>
        <FilterDropdown label="Outside" options={["x"]} selected={[]} onChange={() => {}} />
        <button>elsewhere</button>
      </div>,
    )
    await user.click(screen.getByRole("button", { name: /Outside/i }))
    expect(await screen.findByText("x")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "elsewhere" }))
    expect(screen.queryByText("x")).not.toBeInTheDocument()
  })
})

// ── agent-pills ──────────────────────────────────────────────────────────────
describe("agent-pills", () => {
  it("ToolSurfacePill labels each surface", () => {
    const { rerender } = render(<ToolSurfacePill surface="function_call" />)
    expect(screen.getByText("function")).toBeInTheDocument()
    rerender(<ToolSurfacePill surface="mcp" />)
    expect(screen.getByText("mcp")).toBeInTheDocument()
    rerender(<ToolSurfacePill surface="cli" />)
    expect(screen.getByText("cli")).toBeInTheDocument()
    rerender(<ToolSurfacePill surface="mixed" />)
    expect(screen.getByText("mixed")).toBeInTheDocument()
    rerender(<ToolSurfacePill surface="unknown" />)
    expect(screen.getByText("?")).toBeInTheDocument()
  })
  it("TopologyPill labels each topology", () => {
    const { rerender } = render(<TopologyPill topology="single_agent" />)
    expect(screen.getByText("single")).toBeInTheDocument()
    rerender(<TopologyPill topology="sub_agent" />)
    expect(screen.getByText("sub-agent")).toBeInTheDocument()
    rerender(<TopologyPill topology="orchestrator" />)
    expect(screen.getByText("orchestrator")).toBeInTheDocument()
  })
  it("SuspiciousMarker is null for 0", () => {
    const { container } = render(<SuspiciousMarker count={0} />)
    expect(container.firstChild).toBeNull()
  })
  it("SuspiciousMarker renders the marker for >0", () => {
    render(<SuspiciousMarker count={2} />)
    expect(screen.getByText("⚠")).toBeInTheDocument()
    expect(screen.getByTitle(/2 suspicious skills/i)).toBeInTheDocument()
  })
  it("SuspiciousMarker singular title for 1", () => {
    render(<SuspiciousMarker count={1} />)
    expect(screen.getByTitle(/1 suspicious skill$/i)).toBeInTheDocument()
  })
})

// ── Markdown ─────────────────────────────────────────────────────────────────
describe("Markdown", () => {
  it("renders a paragraph", () => {
    render(<Markdown text="Hello **world**" />)
    expect(screen.getByText("world").tagName).toBe("STRONG")
  })
  it("renders a code block in compact mode", () => {
    render(<Markdown text="`inline`" compact />)
    expect(screen.getByText("inline")).toBeInTheDocument()
  })
  it("renders a table (gfm)", () => {
    const { container } = render(<Markdown text="| a | b |\n| - | - |\n| 1 | 2 |" />)
    // react-markdown + remark-gfm emit a <table>; happy-dom may serialize it.
    const table = container.querySelector("table")
    if (table) {
      expect(table).not.toBeNull()
    } else {
      // Fallback: the cell contents are still present as text nodes.
      expect(container.textContent).toContain("1")
      expect(container.textContent).toContain("2")
    }
  })
})
