import { describe, expect, it } from "bun:test"
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  asUint,
  get,
  parseJsonOrNull,
  stringOrJson,
  toJsonString,
} from "./shared"

describe("asString", () => {
  it("returns the string for strings", () => {
    expect(asString("hi")).toBe("hi")
  })
  it("returns null for non-strings (incl. number, null, undefined, object, array)", () => {
    expect(asString(3)).toBeNull()
    expect(asString(null)).toBeNull()
    expect(asString(undefined)).toBeNull()
    expect(asString({})).toBeNull()
    expect(asString([])).toBeNull()
    expect(asString(true)).toBeNull()
  })
})

describe("asArray", () => {
  it("returns the array for arrays", () => {
    expect(asArray([1, 2])).toEqual([1, 2])
  })
  it("returns null for non-arrays (object, null, string, number)", () => {
    expect(asArray({})).toBeNull()
    expect(asArray(null)).toBeNull()
    expect(asArray("x")).toBeNull()
    expect(asArray(1)).toBeNull()
  })
})

describe("asObject", () => {
  it("returns an object for plain objects", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 })
  })
  it("returns null for arrays (arrays are objects but excluded)", () => {
    expect(asArray([1]) // sanity: arrays are arrays
    ).toEqual([1])
    expect(asObject([1])).toBeNull()
  })
  it("returns null for null and primitives", () => {
    expect(asObject(null)).toBeNull()
    expect(asObject("x")).toBeNull()
    expect(asObject(1)).toBeNull()
    expect(asObject(true)).toBeNull()
  })
})

describe("asNumber", () => {
  it("returns finite numbers", () => {
    expect(asNumber(3)).toBe(3)
    expect(asNumber(0)).toBe(0)
    expect(asNumber(-1.5)).toBe(-1.5)
  })
  it("returns null for non-numbers, NaN, and Infinity", () => {
    expect(asNumber("3")).toBeNull()
    expect(asNumber(null)).toBeNull()
    expect(asNumber(undefined)).toBeNull()
    expect(asNumber(NaN)).toBeNull()
    expect(asNumber(Infinity)).toBeNull()
    expect(asNumber(-Infinity)).toBeNull()
  })
})

describe("asBoolean", () => {
  it("returns the boolean for booleans", () => {
    expect(asBoolean(true)).toBe(true)
    expect(asBoolean(false)).toBe(false)
  })
  it("returns null for truthy/falsy non-booleans", () => {
    expect(asBoolean(0)).toBeNull()
    expect(asBoolean(1)).toBeNull()
    expect(asBoolean("")).toBeNull()
    expect(asBoolean(null)).toBeNull()
    expect(asBoolean(undefined)).toBeNull()
  })
})

describe("asUint", () => {
  it("returns non-negative integers", () => {
    expect(asUint(0)).toBe(0)
    expect(asUint(42)).toBe(42)
  })
  it("returns null for negatives, non-integers, and non-numbers", () => {
    expect(asUint(-1)).toBeNull()
    expect(asUint(1.5)).toBeNull()
    expect(asUint("1")).toBeNull()
    expect(asUint(null)).toBeNull()
    expect(asUint(Infinity)).toBeNull() // asNumber rejects Infinity first
  })
})

describe("get", () => {
  it("returns the value at a key for an object", () => {
    expect(get({ a: "x" }, "a")).toBe("x")
    expect(get({ a: 1 }, "a")).toBe(1)
  })
  it("returns undefined for a missing key", () => {
    expect(get({ a: 1 }, "b")).toBeUndefined()
  })
  it("returns undefined for a non-object target (not throw)", () => {
    expect(get(null, "a")).toBeUndefined()
    expect(get("x", "a")).toBeUndefined()
    expect(get([1], "a")).toBeUndefined()
    expect(get(3, "a")).toBeUndefined()
  })
})

describe("toJsonString", () => {
  it("serializes a value with no whitespace", () => {
    expect(toJsonString({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}')
  })
  it("returns empty string for values that fail to stringify (cycles)", () => {
    const o: any = {}
    o.self = o
    expect(toJsonString(o)).toBe("")
  })
  it("returns the string for null input (JSON.stringify(null) → 'null')", () => {
    expect(toJsonString(null)).toBe("null")
  })
})

describe("parseJsonOrNull", () => {
  it("parses valid JSON", () => {
    expect(parseJsonOrNull('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonOrNull("[1,2,3]")).toEqual([1, 2, 3])
  })
  it("returns null for null / undefined input", () => {
    expect(parseJsonOrNull(null)).toBeNull()
    expect(parseJsonOrNull(undefined)).toBeNull()
  })
  it("returns null for invalid JSON", () => {
    expect(parseJsonOrNull("not json")).toBeNull()
    expect(parseJsonOrNull("{a:1}")).toBeNull()
  })
})

describe("stringOrJson", () => {
  it("returns a string verbatim", () => {
    expect(stringOrJson("hello")).toBe("hello")
  })
  it("returns empty string for null / undefined", () => {
    expect(stringOrJson(null)).toBe("")
    expect(stringOrJson(undefined)).toBe("")
  })
  it("JSON-stringifies any other value (no whitespace)", () => {
    expect(stringOrJson({ a: 1 })).toBe('{"a":1}')
    expect(stringOrJson([1, 2])).toBe("[1,2]")
    expect(stringOrJson(3)).toBe("3")
    expect(stringOrJson(true)).toBe("true")
  })
})
