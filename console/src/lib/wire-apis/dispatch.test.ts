import { describe, expect, it } from "bun:test"
import { classifyType } from "./dispatch"

describe("classifyType — finalCallId short-circuit", () => {
  it("returns 'final' when callId === finalCallId, before any wire-api logic", () => {
    // Unknown wire_api + matching finalCallId → still 'final' (checked first).
    expect(classifyType("unknown-api", null, "c1", "c1")).toBe("final")
  })

  it("does not return 'final' when finalCallId is null", () => {
    expect(classifyType("anthropic", null, "c1", null)).toBe("text")
  })
})

describe("classifyType — per-wire-api dispatch", () => {
  it("routes 'anthropic' to the anthropic classifier (tool_use → tool_call)", () => {
    const body = JSON.stringify({
      content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
    })
    expect(classifyType("anthropic", body, "c1", null)).toBe("tool_call")
  })

  it("routes 'openai-chat' to the openai-chat classifier (tool_calls → tool_call)", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" } }],
          },
        },
      ],
    })
    expect(classifyType("openai-chat", body, "c1", null)).toBe("tool_call")
  })

  it("routes 'openai-responses' to the openai-responses classifier", () => {
    // A plain text response → 'text'.
    const body = JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    })
    expect(classifyType("openai-responses", body, "c1", null)).toBe("text")
  })

  it("routes 'gemini-aistudio' to the gemini classifier (functionCall part → tool_call)", () => {
    const body = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "get_weather", args: {} } }],
          },
        },
      ],
    })
    expect(classifyType("gemini-aistudio", body, "c1", null)).toBe("tool_call")
  })
})

describe("classifyType — unknown wire_api fallback", () => {
  it("falls back to 'text' for an unrecognised wire_api", () => {
    // Conservative: not a tool_call if we can't prove it, not 'final' unless id matches.
    expect(classifyType("some-new-api", null, "c1", null)).toBe("text")
    // Even with a tool-shaped body under an unknown api, we can't classify → text.
    const toolishBody = JSON.stringify({ tool_calls: [{ id: "x" }] })
    expect(classifyType("some-new-api", toolishBody, "c1", null)).toBe("text")
  })

  it("falls back to 'text' for an empty wire_api string", () => {
    expect(classifyType("", null, "c1", null)).toBe("text")
  })
})
