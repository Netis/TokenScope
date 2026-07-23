import { describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GanttNav } from "./gantt-nav"
import type { AgentTurnCallItem, AgentTurnDetail } from "@/types/api"
import {
  baseAgentTurnCallItem,
  baseAgentTurnDetail,
  NOW_MS,
} from "../../../test/fixtures"

function call(seq: number, over: Partial<AgentTurnCallItem> = {}): AgentTurnCallItem {
  return baseAgentTurnCallItem({
    id: `call-${seq}`,
    sequence: seq,
    request_time: NOW_MS + seq * 100,
    response_time: NOW_MS + seq * 100 + 250,
    complete_time: NOW_MS + seq * 100 + 1000,
    request_body: JSON.stringify({ messages: [] }),
    response_body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
    ...over,
  })
}

describe("GanttNav — header", () => {
  it("renders the Timeline header with the formatted duration", () => {
    render(
      <GanttNav
        turn={baseAgentTurnDetail({ duration_ms: 4200 })}
        calls={[]}
        activeSequence={null}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText("Timeline")).toBeInTheDocument()
    // 4200ms → "4.20s"
    expect(screen.getByText("4.20s")).toBeInTheDocument()
  })

  it("shows the 'No calls' placeholder when the call list is empty", () => {
    render(
      <GanttNav turn={baseAgentTurnDetail()} calls={[]} activeSequence={null} onSelect={() => {}} />,
    )
    expect(screen.getByText("No calls")).toBeInTheDocument()
  })
})

describe("GanttNav — call rows", () => {
  it("renders one row per call with the sequence number and latency", () => {
    const calls = [
      call(1, { e2e_latency_ms: 200 }),
      call(2, { e2e_latency_ms: 1500 }),
    ]
    render(
      <GanttNav turn={baseAgentTurnDetail()} calls={calls} activeSequence={null} onSelect={() => {}} />,
    )
    // Each row's title contains the sequence. Sequence numbers render as text.
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    // Latencies via formatMs: 200ms → "200.0ms", 1500ms → "1.50s".
    expect(screen.getByText("200.0ms")).toBeInTheDocument()
    expect(screen.getByText("1.50s")).toBeInTheDocument()
  })

  it("applies the active highlight class to the selected sequence", () => {
    const calls = [call(1), call(2), call(3)]
    const { container } = render(
      <GanttNav turn={baseAgentTurnDetail()} calls={calls} activeSequence={2} onSelect={() => {}} />,
    )
    // The active row gets the bg-blue-50 class. Find the button whose text
    // includes the active sequence ("2") and check its className.
    const activeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.startsWith("2"),
    )
    expect(activeBtn).toBeDefined()
    expect(activeBtn!.className).toContain("bg-blue-50")
  })

  it("fires onSelect with the sequence number when a row is clicked", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const calls = [call(1), call(2)]
    render(
      <GanttNav turn={baseAgentTurnDetail()} calls={calls} activeSequence={null} onSelect={onSelect} />,
    )
    // Click the second row (sequence "2").
    const btns = screen.getAllByRole("button")
    // The Timeline header has no buttons; rows are buttons. Pick the one whose
    // text starts with "2".
    const second = btns.find((b) => b.textContent?.startsWith("2"))
    expect(second).toBeDefined()
    await user.click(second!)
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  it("renders an amber border for slow calls (e2e > 10s)", () => {
    const calls = [call(1, { e2e_latency_ms: 12_000 })]
    const { container } = render(
      <GanttNav turn={baseAgentTurnDetail()} calls={calls} activeSequence={null} onSelect={() => {}} />,
    )
    const row = container.querySelector("button")
    expect(row!.className).toContain("border-amber-500/70")
  })

  it("renders an amber border for warn-tone finish_reasons (e.g. max_tokens)", () => {
    const calls = [call(1, { e2e_latency_ms: 100, finish_reason: "max_tokens" })]
    const { container } = render(
      <GanttNav turn={baseAgentTurnDetail()} calls={calls} activeSequence={null} onSelect={() => {}} />,
    )
    const row = container.querySelector("button")
    expect(row!.className).toContain("border-amber-500/70")
  })

  it("renders a red border for error-status calls (>= 400)", () => {
    const calls = [call(1, { status_code: 500, e2e_latency_ms: 100 })]
    const { container } = render(
      <GanttNav turn={baseAgentTurnDetail()} calls={calls} activeSequence={null} onSelect={() => {}} />,
    )
    const row = container.querySelector("button")
    expect(row!.className).toContain("border-red-500/70")
  })

  it("renders a red border for err-tone finish_reasons (e.g. refusal)", () => {
    const calls = [call(1, { e2e_latency_ms: 100, finish_reason: "refusal" })]
    const { container } = render(
      <GanttNav turn={baseAgentTurnDetail()} calls={calls} activeSequence={null} onSelect={() => {}} />,
    )
    const row = container.querySelector("button")
    expect(row!.className).toContain("border-red-500/70")
  })

  it("renders a blue border for normal calls with folded hops", () => {
    const canonical = call(1, { e2e_latency_ms: 100 })
    const hop = call(2, { e2e_latency_ms: 50 })
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([
      [canonical.id, [hop]],
    ])
    const { container } = render(
      <GanttNav
        turn={baseAgentTurnDetail()}
        calls={[canonical]}
        activeSequence={null}
        onSelect={() => {}}
        hopsByCanonical={hopsByCanonical}
      />,
    )
    const row = container.querySelector("button")
    expect(row!.className).toContain("border-blue-500/70")
    // The folded hop renders a Layers icon and the layer-overlap bar inside.
    expect(container.querySelectorAll(".lucide-layers").length).toBeGreaterThan(0)
  })

  it("adds a tooltip title on a row with folded hops", () => {
    const canonical = call(1)
    const hop = call(2)
    const hopsByCanonical = new Map<string, AgentTurnCallItem[]>([
      [canonical.id, [hop]],
    ])
    const { container } = render(
      <GanttNav
        turn={baseAgentTurnDetail()}
        calls={[canonical]}
        activeSequence={null}
        onSelect={() => {}}
        hopsByCanonical={hopsByCanonical}
      />,
    )
    const row = container.querySelector("button")
    expect(row!.getAttribute("title")).toContain("Folded 1 proxy-duplicate leg(s)")
  })
})

describe("GanttNav — proxy multi-leg badge", () => {
  it("renders the multi-leg badge when the turn is a proxy_in with peer_turn_ids", () => {
    const turn: AgentTurnDetail = baseAgentTurnDetail({
      metadata: { proxy: { role: "proxy_in", peer_turn_ids: ["peer-1", "peer-2"] } },
    })
    render(
      <GanttNav turn={turn} calls={[call(1)]} activeSequence={null} onSelect={() => {}} />,
    )
    // 3-leg badge: "3-leg via proxy"
    expect(screen.getByText(/3-leg via proxy/i)).toBeInTheDocument()
  })

  it("renders 'mirrored' label for mirror_primary role", () => {
    const turn: AgentTurnDetail = baseAgentTurnDetail({
      metadata: { proxy: { role: "mirror_primary", peer_turn_id: "peer-1" } },
    })
    render(
      <GanttNav turn={turn} calls={[call(1)]} activeSequence={null} onSelect={() => {}} />,
    )
    expect(screen.getByText(/2-leg mirrored/i)).toBeInTheDocument()
  })

  it("renders 'proxy hop' label for proxy_out role", () => {
    const turn: AgentTurnDetail = baseAgentTurnDetail({
      metadata: { proxy: { role: "proxy_out", peer_turn_id: "peer-1" } },
    })
    render(
      <GanttNav turn={turn} calls={[call(1)]} activeSequence={null} onSelect={() => {}} />,
    )
    expect(screen.getByText(/2-leg proxy hop/i)).toBeInTheDocument()
  })

  it("renders 'mirror copy' label for mirror_secondary role", () => {
    const turn: AgentTurnDetail = baseAgentTurnDetail({
      metadata: { proxy: { role: "mirror_secondary", peer_turn_id: "peer-1" } },
    })
    render(
      <GanttNav turn={turn} calls={[call(1)]} activeSequence={null} onSelect={() => {}} />,
    )
    expect(screen.getByText(/2-leg mirror copy/i)).toBeInTheDocument()
  })

  it("omits the multi-leg badge when proxy metadata is absent", () => {
    render(
      <GanttNav turn={baseAgentTurnDetail()} calls={[call(1)]} activeSequence={null} onSelect={() => {}} />,
    )
    expect(screen.queryByText(/leg/i)).not.toBeInTheDocument()
  })

  it("omits the multi-leg badge when groupSize < 2", () => {
    const turn: AgentTurnDetail = baseAgentTurnDetail({
      metadata: { proxy: { role: "proxy_in" } },
    })
    render(
      <GanttNav turn={turn} calls={[call(1)]} activeSequence={null} onSelect={() => {}} />,
    )
    expect(screen.queryByText(/leg/i)).not.toBeInTheDocument()
  })
})
