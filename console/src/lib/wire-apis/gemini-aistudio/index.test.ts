import { describe, expect, it } from "bun:test"
import { parseGeminiAiStudioCall } from "./index"

describe("parseGeminiAiStudioCall — null/empty bodies", () => {
  it("returns a default-shaped call for both bodies null", () => {
    const call = parseGeminiAiStudioCall(null, null)
    expect(call.request).toEqual({
      model: null,
      systemInstruction: null,
      contents: [],
      tools: [],
      generationConfig: null,
    })
    expect(call.response).toEqual({
      responseId: null,
      modelVersion: null,
      candidates: [],
      usageMetadata: {
        promptTokenCount: null,
        candidatesTokenCount: null,
        totalTokenCount: null,
        cachedContentTokenCount: null,
        thoughtsTokenCount: null,
      },
    })
  })

  it("returns defaults when bodies are unparseable garbage", () => {
    const call = parseGeminiAiStudioCall("not-json", "also not json")
    expect(call.request.contents).toEqual([])
    expect(call.response.candidates).toEqual([])
    expect(call.response.usageMetadata.totalTokenCount).toBeNull()
  })
})

describe("parseGeminiAiStudioCall — request", () => {
  it("parses model + contents (roles, text parts)", () => {
    const body = JSON.stringify({
      model: "gemini-2.0-flash",
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi there" }] },
      ],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.model).toBe("gemini-2.0-flash")
    expect(call.request.contents).toHaveLength(2)
    expect(call.request.contents[0]).toEqual({
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    })
    expect(call.request.contents[1]).toEqual({
      role: "model",
      parts: [{ type: "text", text: "hi there" }],
    })
  })

  it("maps any non-'model' role to 'user'", () => {
    const body = JSON.stringify({
      contents: [{ role: "system", parts: [{ text: "x" }] }],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.contents[0].role).toBe("user")
  })

  it("parses a thought part (thought:true + text)", () => {
    const body = JSON.stringify({
      contents: [{ role: "model", parts: [{ text: "thinking…", thought: true }] }],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.contents[0].parts[0]).toEqual({
      type: "thought",
      text: "thinking…",
    })
  })

  it("parses a functionCall part (name + raw args)", () => {
    const body = JSON.stringify({
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }],
        },
      ],
    })
    const call = parseGeminiAiStudioCall(body, null)
    const part = call.request.contents[0].parts[0]
    expect(part).toEqual({
      type: "function_call",
      name: "get_weather",
      args: { city: "SF" },
    })
  })

  it("parses a functionResponse part", () => {
    const body = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ functionResponse: { name: "get_weather", response: { temp: 72 } } }],
        },
      ],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.contents[0].parts[0]).toEqual({
      type: "function_response",
      name: "get_weather",
      response: { temp: 72 },
    })
  })

  it("parses an inlineData (image/file) part", () => {
    const body = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data: "iVBOR…" } }],
        },
      ],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.contents[0].parts[0]).toEqual({
      type: "inline_data",
      mimeType: "image/png",
      data: "iVBOR…",
    })
  })

  it("falls back to an 'unknown' part for an unrecognised shape", () => {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ fileData: { fileUri: "x" } }] }],
    })
    const call = parseGeminiAiStudioCall(body, null)
    const part = call.request.contents[0].parts[0]
    expect(part.type).toBe("unknown")
    expect((part as { raw: unknown }).raw).toEqual({ fileData: { fileUri: "x" } })
  })

  it("parses systemInstruction as a content block", () => {
    const body = JSON.stringify({
      systemInstruction: { role: "system", parts: [{ text: "be helpful" }] },
      contents: [],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.systemInstruction).toEqual({
      role: "user",
      parts: [{ type: "text", text: "be helpful" }],
    })
  })

  it("parses functionDeclarations out of the tools array (skips built-in tools)", () => {
    const body = JSON.stringify({
      contents: [],
      tools: [
        { googleSearch: {} },
        {
          functionDeclarations: [
            { name: "search", description: "search the web", parameters: { type: "object" } },
            { name: "calc" },
          ],
        },
        { codeExecution: {} },
      ],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.tools).toHaveLength(2)
    expect(call.request.tools[0]).toEqual({
      name: "search",
      description: "search the web",
      parametersJsonSchema: { type: "object" },
    })
    // No description → null; no parameters → undefined params land as parametersJsonSchema.
    expect(call.request.tools[1].name).toBe("calc")
    expect(call.request.tools[1].description).toBeNull()
  })

  it("prefers parametersJsonSchema over parameters when both present", () => {
    const body = JSON.stringify({
      contents: [],
      tools: [
        {
          functionDeclarations: [
            {
              name: "f",
              parametersJsonSchema: { type: "object", x: 1 },
              parameters: { type: "object", x: 2 },
            },
          ],
        },
      ],
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.tools[0].parametersJsonSchema).toEqual({ type: "object", x: 1 })
  })

  it("parses generationConfig (sampling + thinkingConfig)", () => {
    const body = JSON.stringify({
      contents: [],
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        candidateCount: 1,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingLevel: "low", thinkingBudget: 0, includeThoughts: true },
      },
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.generationConfig).toEqual({
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      candidateCount: 1,
      maxOutputTokens: 1024,
      thinkingConfig: {
        thinkingLevel: "low",
        thinkingBudget: 0,
        includeThoughts: true,
      },
    })
  })

  it("treats generationConfig as null when absent or non-object", () => {
    const call = parseGeminiAiStudioCall(JSON.stringify({ contents: [] }), null)
    expect(call.request.generationConfig).toBeNull()
    const call2 = parseGeminiAiStudioCall(
      JSON.stringify({ contents: [], generationConfig: "x" }),
      null,
    )
    expect(call2.request.generationConfig).toBeNull()
  })

  it("rejects non-uint sampling fields (negatives / fractions)", () => {
    const body = JSON.stringify({
      contents: [],
      generationConfig: { topK: -1, candidateCount: 1.5, maxOutputTokens: 10 },
    })
    const call = parseGeminiAiStudioCall(body, null)
    expect(call.request.generationConfig?.topK).toBeNull()
    expect(call.request.generationConfig?.candidateCount).toBeNull()
    expect(call.request.generationConfig?.maxOutputTokens).toBe(10)
  })
})

describe("parseGeminiAiStudioCall — response", () => {
  it("parses candidates (index, finishReason, content with parts)", () => {
    const body = JSON.stringify({
      responseId: "resp-1",
      modelVersion: "gemini-2.0-flash",
      candidates: [
        {
          index: 0,
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: "answer" }] },
        },
      ],
    })
    const call = parseGeminiAiStudioCall(null, body)
    expect(call.response.responseId).toBe("resp-1")
    expect(call.response.modelVersion).toBe("gemini-2.0-flash")
    expect(call.response.candidates).toHaveLength(1)
    expect(call.response.candidates[0]).toEqual({
      index: 0,
      finishReason: "STOP",
      content: { role: "model", parts: [{ type: "text", text: "answer" }] },
    })
  })

  it("parses usageMetadata (uint counts)", () => {
    const body = JSON.stringify({
      candidates: [],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
        cachedContentTokenCount: 30,
        thoughtsTokenCount: 5,
      },
    })
    const call = parseGeminiAiStudioCall(null, body)
    expect(call.response.usageMetadata).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
      cachedContentTokenCount: 30,
      thoughtsTokenCount: 5,
    })
  })

  it("returns the EMPTY_USAGE default when usageMetadata is absent", () => {
    const call = parseGeminiAiStudioCall(null, JSON.stringify({ candidates: [] }))
    expect(call.response.usageMetadata).toEqual({
      promptTokenCount: null,
      candidatesTokenCount: null,
      totalTokenCount: null,
      cachedContentTokenCount: null,
      thoughtsTokenCount: null,
    })
  })

  it("rejects non-uint usage counts (fractional → null)", () => {
    const body = JSON.stringify({
      usageMetadata: { promptTokenCount: 1.5, totalTokenCount: -3, candidatesTokenCount: 10 },
    })
    const call = parseGeminiAiStudioCall(null, body)
    expect(call.response.usageMetadata.promptTokenCount).toBeNull()
    expect(call.response.usageMetadata.totalTokenCount).toBeNull()
    expect(call.response.usageMetadata.candidatesTokenCount).toBe(10)
  })
})
