import { describe, expect, it } from "bun:test"
import { cn } from "./utils"

describe("cn", () => {
  it("passes a single class through unchanged", () => {
    expect(cn("px-2")).toBe("px-2")
  })

  it("concatenates multiple classes", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1")
  })

  it("drops falsy values (undefined / null / false / empty string)", () => {
    expect(cn("a", undefined, null, false, "", "b")).toBe("a b")
  })

  it("flattens nested arrays and objects (clsx conditional shapes)", () => {
    expect(cn(["a", ["b", { c: true, d: false }]])).toBe("a b c")
  })

  it("resolves conflicting tailwind classes via tailwind-merge (last wins)", () => {
    // px-2 then px-4 → tailwind-merge keeps the later one.
    expect(cn("px-2", "px-4")).toBe("px-4")
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500")
  })

  it("keeps non-conflicting classes and only merges the conflict", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4")
  })

  it("returns an empty string for no/falsy input", () => {
    expect(cn()).toBe("")
    expect(cn(false, undefined, null, "")).toBe("")
  })
})
