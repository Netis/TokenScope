import { describe, expect, it } from "bun:test"
import { ALL_DIMENSIONS, getSpecForPath } from "./page-filter-specs"

describe("getSpecForPath", () => {
  it("returns no dimensions for the agent-sessions routes", () => {
    expect(getSpecForPath("/agent-sessions")).toEqual([])
    expect(getSpecForPath("/agent-sessions/src-1/ses-1")).toEqual([])
  })

  it("returns only serverIp for http-exchanges", () => {
    expect(getSpecForPath("/http-exchanges")).toEqual(["serverIp"])
  })

  it("returns all dimensions for the analytics routes", () => {
    for (const p of ["/agent-turns", "/llm-calls", "/models", "/errors", "/traffic", "/performance"]) {
      expect(getSpecForPath(p)).toEqual(["wireApi", "model", "serverIp"])
    }
  })

  it("returns all dimensions for the root path", () => {
    expect(getSpecForPath("/")).toEqual(["wireApi", "model", "serverIp"])
  })

  it("returns [] for an unknown route (conservative: no filters)", () => {
    expect(getSpecForPath("/no-such-page")).toEqual([])
    expect(getSpecForPath("/debug/pipeline-health")).toEqual([])
  })

  it("normalizes trailing slashes before matching", () => {
    expect(getSpecForPath("/llm-calls/")).toEqual(["wireApi", "model", "serverIp"])
    expect(getSpecForPath("/http-exchanges//")).toEqual(["serverIp"])
    expect(getSpecForPath("/agent-sessions/")).toEqual([])
  })

  it("normalizes a bare trailing-slash URL to '/' (root)", () => {
    // pathname.replace(/\/+$/,"") on "" → "/", and on "/" → "" → "/"
    expect(getSpecForPath("/")).toEqual(["wireApi", "model", "serverIp"])
  })

  it("ALL_DIMENSIONS lists the three dimension keys", () => {
    expect(ALL_DIMENSIONS).toEqual(["wireApi", "model", "serverIp"])
  })

  it("most-specific entry wins (session detail before the sessions list)", () => {
    // /agent-sessions/:source_id/:session_id is listed above /agent-sessions
    // and both map to [], so this asserts ordering doesn't accidentally upgrade.
    expect(getSpecForPath("/agent-sessions/a/b")).toEqual([])
  })

  it("does not match a prefix when end:true (longer paths fall through)", () => {
    // /llm-calls is an exact-match entry; a deeper path isn't /llm-calls.
    expect(getSpecForPath("/llm-calls/123")).toEqual([])
  })
})
