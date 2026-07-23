import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"

import { InTurnProxyView } from "./in-turn-proxy-view"
import type { AgentTurnCallItem } from "@/types/api"
import {
  baseAgentTurnCallItem,
  NOW_MS,
} from "../../../test/fixtures"

function call(seq: number, over: Partial<AgentTurnCallItem> = {}): AgentTurnCallItem {
  return baseAgentTurnCallItem({
    id: `call-${seq}`,
    sequence: seq,
    request_time: NOW_MS,
    complete_time: NOW_MS + 1000,
    e2e_latency_ms: 500,
    ...over,
  })
}

describe("InTurnProxyView", () => {
  it("shows the 'no duplicates' notice when no canonical has folded hops", () => {
    const canonicals = [call(1)]
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>()
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={canonicals} />)
    expect(
      screen.getByText(/No call-level proxy duplicates detected in this turn/i),
    ).toBeInTheDocument()
  })

  it("shows the notice when canonicals is empty", () => {
    render(<InTurnProxyView hopsByCanonical={new Map()} canonicals={[]} />)
    expect(
      screen.getByText(/No call-level proxy duplicates detected in this turn/i),
    ).toBeInTheDocument()
  })

  it("renders one card per canonical-with-hops and the count in the header text", () => {
    const c1 = call(1)
    const c2 = call(2)
    const c3 = call(3) // no hops for c3
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([
      [c1.id, [call(11)]],
      [c2.id, [call(12), call(13)]],
    ])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[c1, c2, c3]} />)
    // The intro sentence names the count of groups (2 of its LLM calls).
    expect(screen.getByText(/2 of its LLM calls/i)).toBeInTheDocument()
    // Each card has a Call #N header.
    expect(screen.getByText(/Call #1/)).toBeInTheDocument()
    expect(screen.getByText(/Call #2/)).toBeInTheDocument()
    // c3 has no hops and so no card.
    expect(screen.queryByText(/Call #3/)).not.toBeInTheDocument()
    // Folded hop counts: c1 → "+ 1 folded hop", c2 → "+ 2 folded hops".
    expect(screen.getByText(/\+ 1 folded hop$/i)).toBeInTheDocument()
    expect(screen.getByText(/\+ 2 folded hops$/i)).toBeInTheDocument()
  })

  it("renders the canonical Client-facing chip and the Proxy hop chip per row", () => {
    const c1 = call(1)
    const hop = call(11)
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([[c1.id, [hop]]])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[c1]} />)
    expect(screen.getByText("Client-facing")).toBeInTheDocument()
    expect(screen.getByText("Proxy hop")).toBeInTheDocument()
  })

  it("renders the 5-tuple of each row in monospace", () => {
    const canonical = call(1, {
      client_ip: "1.1.1.1",
      client_port: 1000,
      server_ip: "2.2.2.2",
      server_port: 2000,
    })
    const hop = call(11, {
      client_ip: "1.1.1.1",
      client_port: 1000,
      server_ip: "3.3.3.3",
      server_port: 3000,
    })
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([[canonical.id, [hop]]])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[canonical]} />)
    expect(screen.getByText("1.1.1.1:1000 → 2.2.2.2:2000")).toBeInTheDocument()
    expect(screen.getByText("1.1.1.1:1000 → 3.3.3.3:3000")).toBeInTheDocument()
  })

  it("renders the proxy overhead delta when canonical and hop latencies are known", () => {
    const canonical = call(1, { e2e_latency_ms: 500 })
    const hop = call(11, { e2e_latency_ms: 400 })
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([[canonical.id, [hop]]])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[canonical]} />)
    // overhead = 500 - 400 = 100.0ms; rendered as "Δ+100.0ms" with the title.
    expect(screen.getByText(/Δ\+100\.0ms/i)).toBeInTheDocument()
  })

  it("renders a negative overhead when the hop is slower than the canonical", () => {
    const canonical = call(1, { e2e_latency_ms: 400 })
    const hop = call(11, { e2e_latency_ms: 500 })
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([[canonical.id, [hop]]])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[canonical]} />)
    expect(screen.getByText(/Δ-100\.0ms/i)).toBeInTheDocument()
  })

  it("omits the overhead delta when the hop latency is null", () => {
    const canonical = call(1, { e2e_latency_ms: 500 })
    const hop = call(11, { e2e_latency_ms: null })
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([[canonical.id, [hop]]])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[canonical]} />)
    expect(screen.queryByText(/Δ/i)).not.toBeInTheDocument()
  })

  it("renders the model-rewrite badge when the hop model differs from canonical", () => {
    const canonical = call(1, { model: "claude-sonnet-4" })
    const hop = call(11, { model: "claude-haiku-3" })
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([[canonical.id, [hop]]])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[canonical]} />)
    expect(screen.getByText("claude-haiku-3")).toBeInTheDocument()
    // The title tooltip names the rewrite.
    expect(screen.getByTitle(/Model rewrite: claude-sonnet-4 → claude-haiku-3/i)).toBeInTheDocument()
  })

  it("omits the model-rewrite badge when the models match", () => {
    const canonical = call(1, { model: "claude-sonnet-4" })
    const hop = call(11, { model: "claude-sonnet-4" })
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([[canonical.id, [hop]]])
    render(<InTurnProxyView hopsByCanonical={hopsByCanonical} canonicals={[canonical]} />)
    // No element carries the model-rewrite tooltip.
    expect(screen.queryByTitle(/Model rewrite/i)).not.toBeInTheDocument()
  })
})
