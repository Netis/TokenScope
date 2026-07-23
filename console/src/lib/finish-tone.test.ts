import { describe, expect, it } from "bun:test"
import { finishTone, TONE_CLASS, type FinishTone } from "./finish-tone"

describe("finishTone", () => {
  it("returns 'muted' for null / undefined / empty string", () => {
    expect(finishTone(null)).toBe("muted")
    expect(finishTone(undefined)).toBe("muted")
    expect(finishTone("")).toBe("muted")
  })

  it("maps natural-completion reasons to 'ok'", () => {
    for (const r of ["end_turn", "stop", "STOP", "stop_sequence", "completed"]) {
      expect(finishTone(r)).toBe("ok")
    }
  })

  it("maps truncation reasons to 'warn'", () => {
    for (const r of [
      "max_tokens",
      "length",
      "MAX_TOKENS",
      "model_context_window_exceeded",
      "incomplete",
    ]) {
      expect(finishTone(r)).toBe("warn")
    }
  })

  it("maps tool-use reasons to 'tool'", () => {
    for (const r of ["tool_use", "tool_calls", "function_call", "TOOL_CALLS"]) {
      expect(finishTone(r)).toBe("tool")
    }
  })

  it("maps server-tool yield to 'pause'", () => {
    expect(finishTone("pause_turn")).toBe("pause")
  })

  it("maps safety / failure reasons to 'err'", () => {
    for (const r of ["refusal", "content_filter", "SAFETY", "RECITATION", "failed", "cancelled"]) {
      expect(finishTone(r)).toBe("err")
    }
  })

  it("falls back to 'muted' for an unknown reason", () => {
    expect(finishTone("something_weird")).toBe("muted")
  })
})

describe("TONE_CLASS", () => {
  // Every tone the classifier can emit must have a matching class, so a
  // finish badge never renders without styling.
  const ALL_TONES: FinishTone[] = ["ok", "warn", "tool", "pause", "err", "muted"]

  it("has a non-empty class string for every FinishTone", () => {
    for (const t of ALL_TONES) {
      expect(TONE_CLASS[t].length).toBeGreaterThan(0)
    }
  })

  it("each tone has a distinct class set", () => {
    const classes = ALL_TONES.map((t) => TONE_CLASS[t])
    expect(new Set(classes).size).toBe(ALL_TONES.length)
  })

  it("the dark-mode variant is present on every tone", () => {
    for (const t of ALL_TONES) {
      expect(TONE_CLASS[t]).toContain("dark:")
    }
  })
})
