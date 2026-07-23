import { describe, expect, it } from "bun:test"
import {
  collapsedArrayPreview,
  collapsedObjectPreview,
  defaultExpansion,
  formatJson,
  formatSize,
  parseHeaders,
  tryParseJson,
  walkAllPaths,
} from "./helpers"

// ── parseHeaders ────────────────────────────────────────────────────────────
describe("parseHeaders", () => {
  it("returns [] for null/empty input", () => {
    expect(parseHeaders(null)).toEqual([])
    expect(parseHeaders("")).toEqual([])
  })

  it("returns [] for invalid JSON", () => {
    expect(parseHeaders("not-json")).toEqual([])
    expect(parseHeaders("{bad")).toEqual([])
  })

  it("returns [] when the parsed value is not an array", () => {
    expect(parseHeaders('{"a":1}')).toEqual([])
    expect(parseHeaders('"hi"')).toEqual([])
    expect(parseHeaders("42")).toEqual([])
  })

  it("parses a [[name, value], ...] shape into tuples", () => {
    const raw = JSON.stringify([
      ["content-type", "application/json"],
      ["x-trace-id", "abc-123"],
    ])
    expect(parseHeaders(raw)).toEqual([
      ["content-type", "application/json"],
      ["x-trace-id", "abc-123"],
    ])
  })

  it("passes through an empty array", () => {
    expect(parseHeaders("[]")).toEqual([])
  })
})

// ── formatJson ────────────────────────────────────────────────────────────────
describe("formatJson", () => {
  it("returns '' for null/empty input", () => {
    expect(formatJson(null)).toBe("")
    expect(formatJson("")).toBe("")
  })

  it("pretty-prints valid JSON with 2-space indent", () => {
    expect(formatJson('{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  it("returns raw unchanged on parse failure", () => {
    expect(formatJson("not-json")).toBe("not-json")
    expect(formatJson("{bad")).toBe("{bad")
  })
})

// ── tryParseJson ─────────────────────────────────────────────────────────────
describe("tryParseJson", () => {
  it("returns undefined for null", () => {
    expect(tryParseJson(null)).toBeUndefined()
  })

  it("returns undefined on parse failure", () => {
    expect(tryParseJson("nope")).toBeUndefined()
    expect(tryParseJson("{bad")).toBeUndefined()
  })

  it("returns the parsed value on success", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 })
    expect(tryParseJson('[1,2,3]')).toEqual([1, 2, 3])
    expect(tryParseJson("42")).toBe(42)
    expect(tryParseJson('"hi"')).toBe("hi")
    expect(tryParseJson("null")).toBeNull()
  })
})

// ── formatSize ───────────────────────────────────────────────────────────────
describe("formatSize", () => {
  it("returns '0 B' for null/empty input", () => {
    expect(formatSize(null)).toBe("0 B")
    expect(formatSize("")).toBe("0 B")
  })

  it("returns bytes for small bodies", () => {
    expect(formatSize("abc")).toBe("3 B")
  })

  it("switches to KB at 1024 bytes", () => {
    // 1025 chars — multibyte counted via Blob([s]).size, but for ASCII size === length.
    const big = "x".repeat(1025)
    const out = formatSize(big)
    expect(out.endsWith(" KB")).toBe(true)
    // 1025 / 1024 = 1.0009... → toFixed(1) → "1.0"
    expect(out).toBe("1.0 KB")
  })

  it("keeps 1.5 KB precision at 1536 bytes", () => {
    const big = "x".repeat(1536)
    expect(formatSize(big)).toBe("1.5 KB")
  })
})

// ── collapsedObjectPreview ───────────────────────────────────────────────────
describe("collapsedObjectPreview", () => {
  it("returns '{}' for empty object", () => {
    expect(collapsedObjectPreview({})).toBe("{}")
  })

  it("shows up to 2 top-level keys with the ': ...' suffix", () => {
    expect(collapsedObjectPreview({ a: 1 })).toBe("{a: ...}")
    expect(collapsedObjectPreview({ a: 1, b: 2 })).toBe("{a: ..., b: ...}")
  })

  it("truncates beyond the first 2 keys", () => {
    expect(collapsedObjectPreview({ a: 1, b: 2, c: 3 })).toBe("{a: ..., b: ...}")
  })

  it("truncates the line itself when it exceeds 60 chars", () => {
    const longKey = "x".repeat(60)
    const out = collapsedObjectPreview({ [longKey]: 1, second: 2 })
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out.endsWith("…")).toBe(true)
  })
})

// ── collapsedArrayPreview ────────────────────────────────────────────────────
describe("collapsedArrayPreview", () => {
  it("returns '[]' for empty array", () => {
    expect(collapsedArrayPreview([])).toBe("[]")
  })

  it("returns '[N items]' for non-empty arrays", () => {
    expect(collapsedArrayPreview([1])).toBe("[1 items]")
    expect(collapsedArrayPreview([1, 2, 3])).toBe("[3 items]")
  })
})

// ── walkAllPaths ──────────────────────────────────────────────────────────────
describe("walkAllPaths", () => {
  it("returns [] for primitives and null", () => {
    expect(walkAllPaths(42)).toEqual([])
    expect(walkAllPaths("hi")).toEqual([])
    expect(walkAllPaths(null)).toEqual([])
    expect(walkAllPaths(undefined)).toEqual([])
    expect(walkAllPaths(true)).toEqual([])
  })

  it("walks a flat object starting at $ (only container paths are recorded)", () => {
    // walkAllPaths yields the path of every object/array node, NOT the
    // leaf primitives. A flat object's only container is the root.
    expect(walkAllPaths({ a: 1, b: 2 })).toEqual(["$"])
  })

  it("walks a flat array starting at $ (root only — primitives are not pushed)", () => {
    expect(walkAllPaths([1, 2])).toEqual(["$"])
  })

  it("walks nested objects and arrays, recording every container path", () => {
    const v = { a: [1, 2], b: { c: "x" } }
    const paths = walkAllPaths(v)
    // root, $.a (array), $.b (object). $.b.c is a string → not recorded.
    expect(paths).toContain("$")
    expect(paths).toContain("$.a")
    expect(paths).toContain("$.b")
    // primitive children are not pushed
    expect(paths).not.toContain("$.a[0]")
    expect(paths).not.toContain("$.a[1]")
    expect(paths).not.toContain("$.b.c")
  })

  it("records child-array container paths when an item is itself an array", () => {
    const paths = walkAllPaths({ outer: [[1]] })
    // root, $.outer, $.outer[0] (an inner array)
    expect(paths).toContain("$")
    expect(paths).toContain("$.outer")
    expect(paths).toContain("$.outer[0]")
  })

  it("honors a caller-supplied root path", () => {
    const paths = walkAllPaths({ a: 1 }, "$root")
    expect(paths).toEqual(["$root"])
  })
})

// ── defaultExpansion ─────────────────────────────────────────────────────────
describe("defaultExpansion", () => {
  it("returns {} for primitives and null", () => {
    expect(defaultExpansion(42)).toEqual({})
    expect(defaultExpansion(null)).toEqual({})
    expect(defaultExpansion("hi")).toEqual({})
  })

  it("opens the first two nesting levels (depth 0 and 1)", () => {
    const v = { a: { b: { c: 1 } } }
    const exp = defaultExpansion(v)
    expect(exp["$"]).toBe(true)
    expect(exp["$.a"]).toBe(true)
    // depth 2 — not opened by default
    expect(exp["$.a.b"]).toBeUndefined()
  })

  it("opens array roots (depth 0) and item sub-objects at depth 1", () => {
    const v = [{ x: 1 }]
    const exp = defaultExpansion(v)
    expect(exp["$"]).toBe(true)
    expect(exp["$[0]"]).toBe(true)
    // depth 2 — not opened
    expect(exp["$[0].x"]).toBeUndefined()
  })

  it("does not descend into nested arrays past depth 2", () => {
    const v = { outer: [[1]] }
    const exp = defaultExpansion(v)
    expect(exp["$"]).toBe(true)
    expect(exp["$.outer"]).toBe(true)
    // depth 2 — inner array is not auto-opened
    expect(exp["$.outer[0]"]).toBeUndefined()
  })
})
