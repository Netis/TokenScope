import { describe, expect, it } from "bun:test"
import {
  batchTrajectoriesUrl,
  sessionTrajectoryUrl,
  turnTrajectoryUrl,
} from "./trajectory-export"

describe("turnTrajectoryUrl", () => {
  it("builds a turn-scoped export URL with scope=turn", () => {
    const url = turnTrajectoryUrl("abc 123")
    expect(url.startsWith("/api/export/trajectory?")).toBe(true)
    const qs = new URLSearchParams(url.split("?")[1])
    expect(qs.get("scope")).toBe("turn")
    expect(qs.get("turn_id")).toBe("abc 123")
  })

  it("URL-encodes the turn id", () => {
    const url = turnTrajectoryUrl("a&b=c")
    const qs = new URLSearchParams(url.split("?")[1])
    expect(qs.get("turn_id")).toBe("a&b=c")
  })
})

describe("sessionTrajectoryUrl", () => {
  it("builds a session-scoped export URL with source_id + session_id", () => {
    const url = sessionTrajectoryUrl("src-1", "ses-2")
    const qs = new URLSearchParams(url.split("?")[1])
    expect(qs.get("scope")).toBe("session")
    expect(qs.get("source_id")).toBe("src-1")
    expect(qs.get("session_id")).toBe("ses-2")
  })
})

describe("batchTrajectoriesUrl", () => {
  it("always includes start and end (required toolbar window)", () => {
    const url = batchTrajectoriesUrl({ start: 1000, end: 2000 })
    const qs = new URLSearchParams(url.split("?")[1])
    expect(qs.get("start")).toBe("1000")
    expect(qs.get("end")).toBe("2000")
  })

  it("includes only the endpoint path, not the full envelope (trajectories, plural)", () => {
    expect(batchTrajectoriesUrl({ start: 1, end: 2 }).startsWith("/api/export/trajectories?")).toBe(true)
  })

  it("omits optional filters that are undefined or empty", () => {
    const url = batchTrajectoriesUrl({ start: 1, end: 2, model: "", wire_api: undefined })
    const qs = new URLSearchParams(url.split("?")[1])
    expect(qs.has("model")).toBe(false)
    expect(qs.has("wire_api")).toBe(false)
    expect(qs.has("agent_kind")).toBe(false)
    expect(qs.has("server_ip")).toBe(false)
    expect(qs.has("status")).toBe(false)
    expect(qs.has("client_ip")).toBe(false)
    expect(qs.has("server_port")).toBe(false)
  })

  it("includes optional filters that are set", () => {
    const url = batchTrajectoriesUrl({
      start: 1,
      end: 2,
      wire_api: "anthropic",
      model: "claude-3",
      server_ip: "10.0.0.1",
      status: "success",
      agent_kind: "claude-cli",
      client_ip: "192.168.1.5",
      server_port: "443",
    })
    const qs = new URLSearchParams(url.split("?")[1])
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("model")).toBe("claude-3")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
    expect(qs.get("status")).toBe("success")
    expect(qs.get("agent_kind")).toBe("claude-cli")
    expect(qs.get("client_ip")).toBe("192.168.1.5")
    expect(qs.get("server_port")).toBe("443")
  })

  it("adds include_proxy_hops=true only when the flag is on", () => {
    expect(
      new URLSearchParams(
        batchTrajectoriesUrl({ start: 1, end: 2 }).split("?")[1],
      ).has("include_proxy_hops"),
    ).toBe(false)
    expect(
      new URLSearchParams(
        batchTrajectoriesUrl({ start: 1, end: 2, include_proxy_hops: true }).split("?")[1],
      ).get("include_proxy_hops"),
    ).toBe("true")
    // Falsy (false / undefined) → omitted, never "false".
    expect(
      new URLSearchParams(
        batchTrajectoriesUrl({ start: 1, end: 2, include_proxy_hops: false }).split("?")[1],
      ).has("include_proxy_hops"),
    ).toBe(false)
  })
})
