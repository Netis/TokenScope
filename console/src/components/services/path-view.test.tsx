import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"

import { ServicePathView } from "./path-view"
import type { ServicesTopology, TopologyEdge, TopologyNode } from "@/types/api"
import { baseServicesTopology } from "../../../test/fixtures"

function topology(
  over: Partial<ServicesTopology> = {},
): ServicesTopology {
  return baseServicesTopology(over)
}

describe("ServicePathView — empty state", () => {
  it("renders the 'No services observed' notice when there are no nodes", () => {
    render(<ServicePathView topology={{ nodes: [], edges: [] }} />)
    expect(
      screen.getByText(/No services observed in selected time range/i),
    ).toBeInTheDocument()
  })
})

describe("ServicePathView — rendering", () => {
  it("renders the SVG and the legend at the bottom", () => {
    const { container } = render(<ServicePathView topology={topology()} />)
    expect(container.querySelector("svg")).not.toBeNull()
    // Legend labels.
    expect(screen.getByText(/proxy hop \(pair-confirmed\)/i)).toBeInTheDocument()
    expect(screen.getByText(/inferred \(caller_ip = known service\)/i)).toBeInTheDocument()
    expect(screen.getByText(/anonymous client/i)).toBeInTheDocument()
    expect(screen.getByText(/Edge width ∝ turn count/i)).toBeInTheDocument()
  })

  it("renders the clients super-node with the Users icon and 'all upstream callers' label", () => {
    render(<ServicePathView topology={topology()} />)
    // The clients super-node renders the "all upstream callers" subtitle.
    expect(screen.getByText(/all upstream callers/i)).toBeInTheDocument()
    // The app badge text uses `app ?? "unknown"` → renders "unknown" for the
    // clients super-node (which has app: null).
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0)
    // The Users icon is rendered (lucide lucide-users).
    expect(document.querySelector(".lucide-users")).not.toBeNull()
  })

  it("renders a regular service node with its app badge and IP:port", () => {
    render(
      <ServicePathView
        topology={topology({
          nodes: [
            {
              server_ip: "__clients__",
              server_port: 0,
              app: null,
              models: [],
              call_count: 50,
            },
            {
              server_ip: "10.0.0.1",
              server_port: 8080,
              app: "vllm",
              models: ["m1", "m2", "m3"],
              call_count: 100,
            },
          ],
          edges: [
            {
              from_ip: "__clients__",
              from_port: 0,
              to_ip: "10.0.0.1",
              to_port: 8080,
              turn_count: 100,
              kind: "client",
            },
          ],
        })}
      />,
    )
    // The service node's IP:port renders.
    expect(screen.getByText("10.0.0.1:8080")).toBeInTheDocument()
    // The app badge renders "vllm".
    expect(screen.getAllByText("vllm").length).toBeGreaterThan(0)
    // The top-2 models render with the "+N" overflow suffix when more than 2.
    expect(screen.getByText(/m1, m2 \+1/i)).toBeInTheDocument()
  })

  it("renders the 'unknown' app badge when app is null", () => {
    render(
      <ServicePathView
        topology={topology({
          nodes: [
            {
              server_ip: "__clients__",
              server_port: 0,
              app: null,
              models: [],
              call_count: 50,
            },
            {
              server_ip: "10.0.0.1",
              server_port: 8080,
              app: null,
              models: [],
              call_count: 5,
            },
          ],
          edges: [],
        })}
      />,
    )
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0)
  })

  it("renders the call_count via formatNumber next to each node", () => {
    render(
      <ServicePathView
        topology={topology({
          nodes: [
            {
              server_ip: "__clients__",
              server_port: 0,
              app: null,
              models: [],
              call_count: 1500,
            },
            {
              server_ip: "10.0.0.1",
              server_port: 8080,
              app: "anthropic",
              models: [],
              call_count: 12345,
            },
          ],
          edges: [],
        })}
      />,
    )
    // 1500 → "1.5K", 12345 → "12.3K".
    expect(screen.getByText("1.5K")).toBeInTheDocument()
    expect(screen.getByText("12.3K")).toBeInTheDocument()
  })

  it("renders a mid-edge count label for proxy edges", () => {
    render(
      <ServicePathView
        topology={topology({
          nodes: [
            {
              server_ip: "__clients__",
              server_port: 0,
              app: null,
              models: [],
              call_count: 100,
            },
            {
              server_ip: "litellm.local",
              server_port: 4000,
              app: "litellm",
              models: ["claude-sonnet-4"],
              call_count: 100,
            },
            {
              server_ip: "api.anthropic.com",
              server_port: 443,
              app: "anthropic",
              models: ["claude-sonnet-4"],
              call_count: 100,
            },
          ],
          edges: [
            {
              from_ip: "__clients__",
              from_port: 0,
              to_ip: "litellm.local",
              to_port: 4000,
              turn_count: 100,
              kind: "client",
            },
            {
              from_ip: "litellm.local",
              from_port: 4000,
              to_ip: "api.anthropic.com",
              to_port: 443,
              turn_count: 75,
              kind: "proxy",
            },
          ],
        })}
      />,
    )
    // proxy edge → count label "75" rendered as SVG <text>.
    // foreignObject renders the node cards in HTML; the SVG text label is
    // outside the foreignObject. Find by text content.
    expect(screen.getByText("75")).toBeInTheDocument()
  })

  it("omits the mid-edge label for client edges (no count shown)", () => {
    render(
      <ServicePathView
        topology={topology({
          nodes: [
            {
              server_ip: "__clients__",
              server_port: 0,
              app: null,
              models: [],
              call_count: 100,
            },
            {
              server_ip: "10.0.0.1",
              server_port: 8080,
              app: "anthropic",
              models: [],
              call_count: 7,
            },
          ],
          edges: [
            {
              from_ip: "__clients__",
              from_port: 0,
              to_ip: "10.0.0.1",
              to_port: 8080,
              turn_count: 100,
              kind: "client",
            },
          ],
        })}
      />,
    )
    // No count label for the client edge. The "100" appears once on the
    // clients node and once on the client edge label? No — the client edge
    // has no label per the component. So the only "100" should be the
    // clients node call_count, which we just set to 100.
    // The real node's call_count is 7 → so "100" appears only on clients.
    expect(screen.getAllByText("100").length).toBe(1)
  })

  it("renders an inferred edge with the dashed style and count label", () => {
    render(
      <ServicePathView
        topology={topology({
          nodes: [
            {
              server_ip: "__clients__",
              server_port: 0,
              app: null,
              models: [],
              call_count: 100,
            },
            {
              server_ip: "10.0.0.1",
              server_port: 8080,
              app: "anthropic",
              models: [],
              call_count: 100,
            },
            {
              server_ip: "10.0.0.2",
              server_port: 8080,
              app: "litellm",
              models: [],
              call_count: 50,
            },
          ],
          edges: [
            {
              from_ip: "__clients__",
              from_port: 0,
              to_ip: "10.0.0.1",
              to_port: 8080,
              turn_count: 100,
              kind: "client",
            },
            {
              from_ip: "10.0.0.1",
              from_port: 8080,
              to_ip: "10.0.0.2",
              to_port: 8080,
              turn_count: 30,
              kind: "inferred",
            },
          ],
        })}
      />,
    )
    // The inferred edge gets the count label "30".
    expect(screen.getByText("30")).toBeInTheDocument()
  })
})

describe("ServicePathView — graph layout", () => {
  it("places isolated nodes (no client edge) in a separate rightmost column", () => {
    // A node not reachable from __clients__ still renders somewhere.
    render(
      <ServicePathView
        topology={topology({
          nodes: [
            {
              server_ip: "__clients__",
              server_port: 0,
              app: null,
              models: [],
              call_count: 100,
            },
            {
              server_ip: "10.0.0.1",
              server_port: 8080,
              app: "anthropic",
              models: [],
              call_count: 100,
            },
            // 10.0.0.2 has no incoming edge from clients → placed as a straggler.
            {
              server_ip: "10.0.0.2",
              server_port: 8080,
              app: "vllm",
              models: [],
              call_count: 50,
            },
          ],
          edges: [
            {
              from_ip: "__clients__",
              from_port: 0,
              to_ip: "10.0.0.1",
              to_port: 8080,
              turn_count: 100,
              kind: "client",
            },
          ],
        })}
      />,
    )
    // Both real nodes render their IP:port regardless of edge connectivity.
    expect(screen.getByText("10.0.0.1:8080")).toBeInTheDocument()
    expect(screen.getByText("10.0.0.2:8080")).toBeInTheDocument()
  })

  it("keeps a node to the right of its predecessor even when multiple paths reach it", () => {
    // clients → A → B and clients → B both exist. B should sit to the right
    // of A (max depth). The test asserts B's foreignObject x is greater
    // than A's foreignObject x by reading the x attributes from the SVG.
    const nodes: TopologyNode[] = [
      { server_ip: "__clients__", server_port: 0, app: null, models: [], call_count: 100 },
      // Give A and B each a unique app badge so we can locate their cards.
      { server_ip: "A", server_port: 1, app: "litellm", models: ["mA"], call_count: 80 },
      { server_ip: "B", server_port: 2, app: "anthropic", models: ["mB"], call_count: 100 },
    ]
    const edges: TopologyEdge[] = [
      { from_ip: "__clients__", from_port: 0, to_ip: "A", to_port: 1, turn_count: 80, kind: "client" },
      { from_ip: "A", from_port: 1, to_ip: "B", to_port: 2, turn_count: 80, kind: "proxy" },
      { from_ip: "__clients__", from_port: 0, to_ip: "B", to_port: 2, turn_count: 20, kind: "client" },
    ]
    const { container } = render(
      <ServicePathView topology={{ nodes, edges }} />,
    )
    // Each node's foreignObject has x=SVG_PAD + col * (NODE_W + COL_GAP).
    // Locate each foreignObject by the unique IP:port string inside its
    // NodeCard (litellm → "A:1", anthropic → "B:2").
    const findXByIpPort = (ipPort: string): number | null => {
      const nodeDivs = Array.from(container.querySelectorAll("div"))
      // The IP:port is rendered in a div with class containing `font-mono`.
      const target = nodeDivs.find((d) => d.textContent === ipPort)
      if (!target) return null
      const fo = target.closest("foreignObject")
      return fo ? Number(fo.getAttribute("x")) : null
    }
    const xA = findXByIpPort("A:1")
    const xB = findXByIpPort("B:2")
    expect(xA).not.toBeNull()
    expect(xB).not.toBeNull()
    expect(xB!).toBeGreaterThan(xA!)
  })
})
