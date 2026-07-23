import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  GeminiAiStudioCallView,
  GeminiAiStudioOutputBlocks,
  GeminiAiStudioInputBlocks,
  geminiAiStudioParseForOutput,
  geminiAiStudioParseForInput,
} from "./gemini-aistudio"
import type {
  GeminiResponse,
} from "@/lib/wire-apis/gemini-aistudio/types"

// ── parse helpers ──────────────────────────────────────────────────────────

describe("geminiAiStudioParseForOutput", () => {
  it("parses a happy-path response", () => {
    const res = JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Hi" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    })
    const { response } = geminiAiStudioParseForOutput(null, res)
    expect(response.candidates).toHaveLength(1)
    expect(response.candidates[0].content.parts[0]).toMatchObject({ type: "text", text: "Hi" })
    expect(response.usageMetadata.promptTokenCount).toBe(3)
  })

  it("returns an empty response when body is null", () => {
    const { response } = geminiAiStudioParseForOutput(null, null)
    expect(response.candidates).toEqual([])
  })
})

describe("geminiAiStudioParseForInput", () => {
  it("returns empty deltas when requestBody is null", () => {
    expect(geminiAiStudioParseForInput(null)).toEqual({ functionResponses: [], extraUserText: null })
  })

  it("returns empty deltas when there is no user content", () => {
    const req = JSON.stringify({ contents: [{ role: "model", parts: [{ text: "hi" }] }] })
    expect(geminiAiStudioParseForInput(req)).toEqual({ functionResponses: [], extraUserText: null })
  })

  it("extracts function_responses and trailing user text from the last user content", () => {
    const req = JSON.stringify({
      contents: [
        { role: "user", content: "first" } as unknown,
        { role: "user", parts: [{ text: "first user" }] },
        { role: "model", parts: [{ functionCall: { name: "do", args: {} } }] },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "do", response: { ok: true } } },
            { functionResponse: { name: "search", response: "result text" } },
            { text: "follow up" },
          ],
        },
      ],
    })
    const parsed = geminiAiStudioParseForInput(req)
    expect(parsed.functionResponses).toEqual([
      { name: "do", response: JSON.stringify({ ok: true }, null, 2) },
      { name: "search", response: "result text" },
    ])
    expect(parsed.extraUserText).toBe("follow up")
  })
})

// ── GeminiAiStudioOutputBlocks ──────────────────────────────────────────────

describe("GeminiAiStudioOutputBlocks", () => {
  it("renders the no-candidates notice when candidates is empty", () => {
    const response: GeminiResponse = {
      responseId: null, modelVersion: null, candidates: [],
      usageMetadata: { promptTokenCount: null, candidatesTokenCount: null, totalTokenCount: null, cachedContentTokenCount: null, thoughtsTokenCount: null },
    }
    render(<GeminiAiStudioOutputBlocks response={response} />)
    expect(screen.getByText(/No response candidates/i)).toBeInTheDocument()
  })

  it("renders parts directly for a single-candidate response", () => {
    const response: GeminiResponse = {
      responseId: null, modelVersion: null,
      candidates: [{
        index: 0,
        finishReason: "STOP",
        content: { role: "model", parts: [
          { type: "text", text: "answer" },
          { type: "thought", text: "thinking" },
          { type: "function_call", name: "search", args: { q: "x" } },
        ] },
      }],
      usageMetadata: { promptTokenCount: null, candidatesTokenCount: null, totalTokenCount: null, cachedContentTokenCount: null, thoughtsTokenCount: null },
    }
    render(<GeminiAiStudioOutputBlocks response={response} />)
    expect(screen.getByText("answer")).toBeInTheDocument()
    // thinking summary is collapsed; expand to see text
    expect(screen.getByText(/thinking/i)).toBeInTheDocument()
    // function_call part shows the name
    expect(screen.getByText("search")).toBeInTheDocument()
  })

  it("renders multi-candidate responses with separators", () => {
    const response: GeminiResponse = {
      responseId: null, modelVersion: null,
      candidates: [
        { index: 0, finishReason: "STOP", content: { role: "model", parts: [{ type: "text", text: "first" }] } },
        { index: 1, finishReason: "MAX_TOKENS", content: { role: "model", parts: [{ type: "text", text: "second" }] } },
      ],
      usageMetadata: { promptTokenCount: null, candidatesTokenCount: null, totalTokenCount: null, cachedContentTokenCount: null, thoughtsTokenCount: null },
    }
    render(<GeminiAiStudioOutputBlocks response={response} />)
    expect(screen.getByText(/Candidate #1/i)).toBeInTheDocument()
    expect(screen.getByText(/Candidate #2/i)).toBeInTheDocument()
    expect(screen.getByText("first")).toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
    // both finishReason badges render
    expect(screen.getByText("STOP")).toBeInTheDocument()
    expect(screen.getByText("MAX_TOKENS")).toBeInTheDocument()
  })

  it("renders function_response parts", () => {
    const response: GeminiResponse = {
      responseId: null, modelVersion: null,
      candidates: [{
        index: 0, finishReason: "STOP",
        content: { role: "model", parts: [{ type: "function_response", name: "search", response: { ok: true } }] },
      }],
      usageMetadata: { promptTokenCount: null, candidatesTokenCount: null, totalTokenCount: null, cachedContentTokenCount: null, thoughtsTokenCount: null },
    }
    render(<GeminiAiStudioOutputBlocks response={response} />)
    expect(screen.getByText("function_response")).toBeInTheDocument()
    expect(screen.getByText("search")).toBeInTheDocument()
  })

  it("renders image (image/*) and non-image inline_data parts", () => {
    const response: GeminiResponse = {
      responseId: null, modelVersion: null,
      candidates: [{
        index: 0, finishReason: "STOP",
        content: { role: "model", parts: [
          { type: "inline_data", mimeType: "image/png", data: "Zm9v" },
          { type: "inline_data", mimeType: "application/pdf", data: "YWJj" },
        ] },
      }],
      usageMetadata: { promptTokenCount: null, candidatesTokenCount: null, totalTokenCount: null, cachedContentTokenCount: null, thoughtsTokenCount: null },
    }
    render(<GeminiAiStudioOutputBlocks response={response} />)
    expect(screen.getByText(/image \(image\/png\)/i)).toBeInTheDocument()
    expect(screen.getByText(/inline_data \(application\/pdf/i)).toBeInTheDocument()
  })

  it("renders an unknown part inside a foldable details", () => {
    const response: GeminiResponse = {
      responseId: null, modelVersion: null,
      candidates: [{
        index: 0, finishReason: "STOP",
        content: { role: "model", parts: [{ type: "unknown", raw: { foo: "bar" } }] },
      }],
      usageMetadata: { promptTokenCount: null, candidatesTokenCount: null, totalTokenCount: null, cachedContentTokenCount: null, thoughtsTokenCount: null },
    }
    render(<GeminiAiStudioOutputBlocks response={response} />)
    expect(screen.getByText(/unknown part/i)).toBeInTheDocument()
  })

  it("expands a thinking part on click", async () => {
    const user = userEvent.setup()
    const response: GeminiResponse = {
      responseId: null, modelVersion: null,
      candidates: [{
        index: 0, finishReason: "STOP",
        content: { role: "model", parts: [{ type: "thought", text: "hidden thoughts" }] },
      }],
      usageMetadata: { promptTokenCount: null, candidatesTokenCount: null, totalTokenCount: null, cachedContentTokenCount: null, thoughtsTokenCount: null },
    }
    render(<GeminiAiStudioOutputBlocks response={response} />)
    expect(screen.queryByText("hidden thoughts")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /thinking/i }))
    expect(await screen.findByText("hidden thoughts")).toBeInTheDocument()
  })
})

// ── GeminiAiStudioInputBlocks ───────────────────────────────────────────────

describe("GeminiAiStudioInputBlocks", () => {
  it("shows the no-deltas notice when parsed is empty", () => {
    render(<GeminiAiStudioInputBlocks parsed={{ functionResponses: [], extraUserText: null }} />)
    expect(screen.getByText(/No input deltas/i)).toBeInTheDocument()
  })

  it("renders function_responses and extraUserText", () => {
    const parsed = {
      functionResponses: [
        { name: "do", response: "ok" },
      ],
      extraUserText: "follow up",
    }
    render(<GeminiAiStudioInputBlocks parsed={parsed} />)
    expect(screen.getByText("do")).toBeInTheDocument()
    expect(screen.getByText("ok")).toBeInTheDocument()
    expect(screen.getByText(/follow up/i)).toBeInTheDocument()
  })
})

// ── GeminiAiStudioCallView (full detail) ────────────────────────────────────

describe("GeminiAiStudioCallView", () => {
  it("shows the not-captured notice when hasRequestBody is false", () => {
    render(<GeminiAiStudioCallView requestBody={null} responseBody={null} hasRequestBody={false} />)
    expect(screen.getByText(/Request body not captured/i)).toBeInTheDocument()
  })

  it("renders System Instruction, Contents, Tools, Parameters sections and expands them", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ functionCall: { name: "search", args: { q: "x" } } }] },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "search", response: { ok: true } } },
            { text: "follow up" },
            { inlineData: { mimeType: "image/png", data: "Zm9v" } },
            { mysteryPart: "x" },
          ],
        },
      ],
      systemInstruction: { parts: [{ text: "be helpful" }] },
      tools: [{ functionDeclarations: [{ name: "search", description: "finds", parametersJsonSchema: { type: "object" } }] }],
      generationConfig: {
        temperature: 0.5,
        topP: 0.9,
        topK: 40,
        candidateCount: 1,
        maxOutputTokens: 200,
        thinkingConfig: { thinkingLevel: "high", thinkingBudget: 1024, includeThoughts: true },
      },
    })
    const res = JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5, cachedContentTokenCount: 1, thoughtsTokenCount: 4 },
    })
    render(<GeminiAiStudioCallView requestBody={req} responseBody={res} hasRequestBody />)
    // System Instruction section
    await user.click(screen.getByRole("button", { name: /system instruction/i }))
    expect(await screen.findByText("be helpful")).toBeInTheDocument()
    // Contents section — accessible name is "Contents (3)" (with a space).
    await user.click(screen.getByRole("button", { name: /contents/i }))
    // Tools section — accessible name is "Tools (1)" (with a space).
    await user.click(screen.getByRole("button", { name: /tools/i }))
    expect(await screen.findByText("search")).toBeInTheDocument()
    expect(await screen.findByText(/finds/)).toBeInTheDocument()
    // Parameters section
    await user.click(screen.getByRole("button", { name: /parameters/i }))
    expect(await screen.findByText("0.5")).toBeInTheDocument()
    expect(await screen.findByText("high")).toBeInTheDocument()
    expect(await screen.findByText("1024")).toBeInTheDocument()
  })

  it("renders usage card with cached + thoughts rows", () => {
    const req = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] })
    const res = JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5, cachedContentTokenCount: 1, thoughtsTokenCount: 4 },
    })
    render(<GeminiAiStudioCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText("cached")).toBeInTheDocument()
    expect(screen.getByText("thoughts*")).toBeInTheDocument()
  })

  it("renders various finish_reason badges", () => {
    const reasons = ["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "PROHIBITED_CONTENT", "MALFORMED_FUNCTION_CALL", "TOOL_USE", "weird"]
    for (const r of reasons) {
      const req = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] })
      const res = JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: r, index: 0 }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      })
      const { unmount } = render(<GeminiAiStudioCallView requestBody={req} responseBody={res} hasRequestBody />)
      expect(screen.getByText(r)).toBeInTheDocument()
      unmount()
    }
  })

  it("returns null for SystemInstructionSection / ContentsSection / ToolsSection when empty (but Parameters renders with model)", () => {
    const req = JSON.stringify({ contents: [], model: "gemini-1.5-pro" })
    const res = JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    })
    render(<GeminiAiStudioCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.queryByRole("button", { name: /system instruction/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /contents/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /tools/i })).not.toBeInTheDocument()
    // Parameters section header (model row) still appears
    expect(screen.getByRole("button", { name: /parameters/i })).toBeInTheDocument()
  })

  it("returns null for all sections including Parameters when the entire request is empty", () => {
    const req = JSON.stringify({ contents: [] })
    const res = JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    })
    render(<GeminiAiStudioCallView requestBody={req} responseBody={res} hasRequestBody />)
    // Note: we use substrings because the accessible name has spaces between spans.
    expect(screen.queryByRole("button", { name: /system instruction/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /contents/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /tools/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /parameters/i })).not.toBeInTheDocument()
  })

  it("renders GenerationConfigSection with thinkingConfig fields", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        temperature: 0.5,
        thinkingConfig: { includeThoughts: false, thinkingBudget: 512 },
      },
    })
    const res = JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    })
    render(<GeminiAiStudioCallView requestBody={req} responseBody={res} hasRequestBody />)
    await user.click(screen.getByRole("button", { name: /parameters/i }))
    expect(await screen.findByText("0.5")).toBeInTheDocument()
    expect(await screen.findByText("512")).toBeInTheDocument()
    expect(await screen.findByText("false")).toBeInTheDocument()
  })
})
