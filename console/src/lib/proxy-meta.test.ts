import { describe, expect, it } from "bun:test"
import { proxyGroupSize, readProxyMeta } from "./proxy-meta"

describe("readProxyMeta", () => {
  it("returns null when metadata is null/undefined/non-object", () => {
    expect(readProxyMeta(null)).toBeNull()
    expect(readProxyMeta(undefined)).toBeNull()
    expect(readProxyMeta("nope")).toBeNull()
    expect(readProxyMeta(42)).toBeNull()
    expect(readProxyMeta([1, 2, 3])).toBeNull()
  })

  it("returns null when there is no proxy block", () => {
    expect(readProxyMeta({})).toBeNull()
    expect(readProxyMeta({ other: "x" })).toBeNull()
  })

  it("returns null when the proxy block is not an object", () => {
    expect(readProxyMeta({ proxy: "x" })).toBeNull()
    expect(readProxyMeta({ proxy: 7 })).toBeNull()
    expect(readProxyMeta({ proxy: null })).toBeNull()
  })

  it("returns null when proxy.role is missing or non-string", () => {
    expect(readProxyMeta({ proxy: {} })).toBeNull()
    expect(readProxyMeta({ proxy: { role: 5 } })).toBeNull()
  })

  it("returns the proxy block when role is a string", () => {
    const proxy = { role: "proxy_in", pair_id: "p1" }
    expect(readProxyMeta({ proxy })).toEqual(proxy)
  })

  it("passes through arbitrary role strings (incl. unknown roles)", () => {
    expect(readProxyMeta({ proxy: { role: "mirror_primary" } })).toEqual({
      role: "mirror_primary",
    })
    expect(readProxyMeta({ proxy: { role: "something_new" } })?.role).toBe(
      "something_new",
    )
  })
})

describe("proxyGroupSize", () => {
  it("returns 0 for no proxy", () => {
    expect(proxyGroupSize(null)).toBe(0)
  })

  it("returns 1 when there are no peers (single-leg group)", () => {
    expect(proxyGroupSize({ role: "proxy_in" })).toBe(1)
  })

  it("returns 2 when only peer_turn_id is set", () => {
    expect(proxyGroupSize({ role: "proxy_in", peer_turn_id: "t2" })).toBe(2)
  })

  it("returns peer_turn_ids.length + 1 when peer_turn_ids is a non-empty array", () => {
    expect(
      proxyGroupSize({ role: "proxy_in", peer_turn_ids: ["a", "b", "c"] }),
    ).toBe(4)
  })

  it("falls back to the peer_turn_id branch when peer_turn_ids is empty", () => {
    // Empty array → not > 0, so peer_turn_id (if present) → 2, else 1.
    expect(
      proxyGroupSize({ role: "proxy_in", peer_turn_ids: [], peer_turn_id: "t" }),
    ).toBe(2)
    expect(proxyGroupSize({ role: "proxy_in", peer_turn_ids: [] })).toBe(1)
  })
})
