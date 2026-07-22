import { describe, expect, it } from "bun:test"
import { classifyGeminiAiStudioType } from "./classify"

describe("classifyGeminiAiStudioType", () => {
  it("returns 'final' when callId matches finalCallId (checked first)", () => {
    expect(classifyGeminiAiStudioType(null, "c1", "c1")).toBe("final")
  })

  it("returns 'tool_call' when a candidate's finishReason is TOOL_USE", () => {
    const body = JSON.stringify({
      candidates: [{ finishReason: "TOOL_USE" }],
    })
    expect(classifyGeminiAiStudioType(body, "c1", null)).toBe("tool_call")
  })

  it("returns 'tool_call' when a content part carries functionCall", () => {
    const body = JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ text: "ok" }, { functionCall: { name: "f", args: {} } }],
          },
        },
      ],
    })
    expect(classifyGeminiAiStudioType(body, "c1", null)).toBe("tool_call")
  })

  it("returns 'tool_call' when functionCall appears in a later candidate", () => {
    const body = JSON.stringify({
      candidates: [
        { content: { parts: [{ text: "first" }] } },
        { content: { parts: [{ functionCall: { name: "g" } }] } },
      ],
    })
    expect(classifyGeminiAiStudioType(body, "c1", null)).toBe("tool_call")
  })

  it("returns 'text' when candidates are present but none carry tool calls", () => {
    const body = JSON.stringify({
      candidates: [
        { finishReason: "STOP", content: { parts: [{ text: "hello" }] } },
      ],
    })
    expect(classifyGeminiAiStudioType(body, "c1", null)).toBe("text")
  })

  it("returns 'text' when a candidate has no content / no parts", () => {
    const body = JSON.stringify({ candidates: [{ finishReason: "STOP" }] })
    expect(classifyGeminiAiStudioType(body, "c1", null)).toBe("text")
  })

  it("returns 'text' for a plain-text (no candidates) body", () => {
    expect(classifyGeminiAiStudioType("{}", "c1", null)).toBe("text")
  })

  it("returns 'text' for null / unparseable body", () => {
    expect(classifyGeminiAiStudioType(null, "c1", null)).toBe("text")
    expect(classifyGeminiAiStudioType("not-json", "c1", null)).toBe("text")
  })

  it("returns 'text' when candidates is not an array", () => {
    const body = JSON.stringify({ candidates: "nope" })
    expect(classifyGeminiAiStudioType(body, "c1", null)).toBe("text")
  })
})
