import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolIndex } from "@/lib/turn-index"
import {
  OpenAiChatCallView,
  OpenAiChatOutputBlocks,
  OpenAiChatInputBlocks,
  openaiChatParseForOutput,
  openaiChatParseForInput,
} from "./openai-chat"
import type {
  OpenAiChatResponse,
} from "@/lib/wire-apis/openai-chat/types"
// ── shared fixtures ─────────────────────────────────────────────────────────

const emptyToolIndex: ToolIndex = new Map()

function toolIndexWithResolution(toolCallId: string): ToolIndex {
  const idx: ToolIndex = new Map()
  idx.set(toolCallId, {
    origin: { call_sequence: 1, call_id: "call-1", tool_name: "search", args_json: "{}" },
    resolution: {
      call_sequence: 2, call_id: "call-2", is_error: false, size_bytes: 7, content: "ok",
    },
  })
  return idx
}

// ── parse helpers ──────────────────────────────────────────────────────────

describe("openaiChatParseForOutput", () => {
  it("parses a happy-path response", () => {
    const res = JSON.stringify({
      id: "x", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
    const { response } = openaiChatParseForOutput(null, res)
    expect(response.choices).toHaveLength(1)
    expect(response.choices[0].message.content).toBe("ok")
    expect(response.usage.total_tokens).toBe(3)
  })

  it("returns an empty response when body is null", () => {
    const { response } = openaiChatParseForOutput(null, null)
    expect(response.choices).toEqual([])
  })
})

describe("openaiChatParseForInput", () => {
  it("returns empty deltas when requestBody is null", () => {
    expect(openaiChatParseForInput(null)).toEqual({ toolResults: [], extraUserText: null })
  })

  it("returns empty deltas when no assistant message precedes the tail", () => {
    const req = JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    const parsed = openaiChatParseForInput(req)
    expect(parsed.toolResults).toEqual([])
    expect(parsed.extraUserText).toBe("hi")
  })

  it("extracts tool messages and trailing user text after the last assistant message", () => {
    const req = JSON.stringify({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ask", tool_calls: [{ id: "call_1", type: "function", function: { name: "do", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "tool result" },
        { role: "user", content: "next round" },
      ],
    })
    const parsed = openaiChatParseForInput(req)
    expect(parsed.toolResults).toEqual([
      { tool_call_id: "call_1", content: "tool result" },
    ])
    expect(parsed.extraUserText).toBe("next round")
  })

  it("formats structured (array) tool content as a JSON string", () => {
    // OpenAI tool content is normally a string; arrays of objects become unknown parts.
    // Here we pass an array of typed parts so the parser produces parts, then formatJson
    // produces a stringified representation.
    const req = JSON.stringify({
      messages: [
        { role: "assistant", content: "ask", tool_calls: [{ id: "call_1", type: "function", function: { name: "do", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "structured" }] },
      ],
    })
    const parsed = openaiChatParseForInput(req)
    expect(parsed.toolResults).toHaveLength(1)
    expect(parsed.toolResults[0].tool_call_id).toBe("call_1")
    // content is the pretty-printed JSON of the parsed parts array
    expect(parsed.toolResults[0].content).toContain('"text"')
    expect(parsed.toolResults[0].content).toContain("structured")
  })
})

// ── OpenAiChatOutputBlocks ──────────────────────────────────────────────────

describe("OpenAiChatOutputBlocks", () => {
  it("renders the no-content notice when choices is empty", () => {
    const response: OpenAiChatResponse = {
      id: null, model: null, system_fingerprint: null, service_tier: null,
      choices: [], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_prompt_tokens: null, reasoning_tokens: null },
    }
    render(<OpenAiChatOutputBlocks response={response} />)
    expect(screen.getByText(/No response content/i)).toBeInTheDocument()
  })

  it("renders reasoning_content before content, then tool_calls, then refusal", () => {
    const response: OpenAiChatResponse = {
      id: "x", model: "gpt-4o", system_fingerprint: null, service_tier: null,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "answer",
          reasoning_content: "thinking hard",
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
          refusal: "i refuse",
        },
        finish_reason: "tool_calls",
        logprobs: null,
      }],
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_prompt_tokens: null, reasoning_tokens: null },
    }
    render(<OpenAiChatOutputBlocks response={response} ctx={{ toolIndex: emptyToolIndex, callId: "call-1" }} />)
    expect(screen.getByText("thinking hard")).toBeInTheDocument()
    expect(screen.getByText("answer")).toBeInTheDocument()
    expect(screen.getByText("search")).toBeInTheDocument()
    expect(screen.getByText(/i refuse/i)).toBeInTheDocument()
  })

  it("renders a healthy ToolUsePointer when the tool_index has a matching resolution", () => {
    const response: OpenAiChatResponse = {
      id: "x", model: null, system_fingerprint: null, service_tier: null,
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "tc_match", type: "function", function: { name: "search", arguments: "{}" } }] },
        finish_reason: "tool_calls",
        logprobs: null,
      }],
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_prompt_tokens: null, reasoning_tokens: null },
    }
    render(
      <OpenAiChatOutputBlocks
        response={response}
        ctx={{ toolIndex: toolIndexWithResolution("tc_match"), callId: "call-1" }}
      />,
    )
    expect(screen.getByText(/result in #2 ✓/)).toBeInTheDocument()
  })

  it("renders the logprobs panel expanded with a per-token table", async () => {
    const user = userEvent.setup()
    const response: OpenAiChatResponse = {
      id: "x", model: null, system_fingerprint: null, service_tier: null,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hi" },
        finish_reason: "stop",
        logprobs: [
          { token: "H", logprob: -0.1, bytes: [72], top_logprobs: [{ token: "H", logprob: -0.1, bytes: null }] },
          { token: "i", logprob: -0.2, bytes: [105], top_logprobs: [] },
        ],
      }],
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_prompt_tokens: null, reasoning_tokens: null },
    }
    render(<OpenAiChatOutputBlocks response={response} />)
    // Logprobs header shows "(2 tokens)"
    expect(screen.getByRole("button", { name: /logprobs/i })).toBeInTheDocument()
    expect(screen.getByText(/2 tokens/i)).toBeInTheDocument()
    // expand
    await user.click(screen.getByRole("button", { name: /logprobs/i }))
    // the table renders token H with quoted "H" (JSON.stringify("H") = "\"H\"").
    // Two matches: the token cell + the "top alternatives" cell.
    expect((await screen.findAllByText(/"H"/)).length).toBeGreaterThan(0)
    expect(await screen.findByText(/-0\.100/)).toBeInTheDocument()
  })

  it("renders various finish_reason badges", () => {
    const reasons = ["stop", "length", "tool_calls", "function_call", "content_filter", "weird"]
    for (const r of reasons) {
      const response: OpenAiChatResponse = {
        id: "x", model: null, system_fingerprint: null, service_tier: null,
        choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: r, logprobs: null }],
        usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_prompt_tokens: null, reasoning_tokens: null },
      }
      const { unmount } = render(<OpenAiChatOutputBlocks response={response} />)
      expect(screen.getByText(r)).toBeInTheDocument()
      unmount()
    }
  })
})

// ── OpenAiChatInputBlocks ───────────────────────────────────────────────────

describe("OpenAiChatInputBlocks", () => {
  it("shows the no-deltas notice when parsed is empty", () => {
    render(
      <OpenAiChatInputBlocks
        parsed={{ toolResults: [], extraUserText: null }}
        ctx={{ toolIndex: emptyToolIndex }}
      />,
    )
    expect(screen.getByText(/No input deltas/i)).toBeInTheDocument()
  })

  it("renders tool_results and extraUserText, classifying orphan and healthy states", () => {
    const parsed = {
      toolResults: [
        { tool_call_id: "tc_orphan", content: "no parent" },
      ],
      extraUserText: "extra user message",
    }
    render(<OpenAiChatInputBlocks parsed={parsed} ctx={{ toolIndex: emptyToolIndex }} />)
    expect(screen.getByText("no parent")).toBeInTheDocument()
    expect(screen.getByText(/extra user message/i)).toBeInTheDocument()
  })

  it("renders a healthy ToolResultBackLink when the origin is present", () => {
    const parsed = {
      toolResults: [{ tool_call_id: "tc_match", content: "ok" }],
      extraUserText: null,
    }
    render(
      <OpenAiChatInputBlocks
        parsed={parsed}
        ctx={{ toolIndex: toolIndexWithResolution("tc_match") }}
      />,
    )
    expect(screen.getByText(/from #1/i)).toBeInTheDocument()
  })
})

// ── OpenAiChatCallView (full detail) ────────────────────────────────────────

describe("OpenAiChatCallView", () => {
  it("shows the not-captured notice when hasRequestBody is false", () => {
    render(<OpenAiChatCallView requestBody={null} responseBody={null} hasRequestBody={false} />)
    expect(screen.getByText(/Request body not captured/i)).toBeInTheDocument()
  })

  it("renders the multi-part user message (image_url, input_audio, unknown) and tool_calls in expanded row", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "high" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
            { type: "mystery", foo: "bar" },
          ],
        },
        {
          role: "assistant",
          tool_calls: [{ id: "tc_x", type: "function", function: { name: "search", arguments: "{}" } }],
          content: null,
        },
        { role: "tool", tool_call_id: "tc_x", content: "result" },
      ],
      max_tokens: 100,
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    // Expand the Messages section.
    await user.click(screen.getByRole("button", { name: /messages \(3\)/i }))
    // Open the user row (its accessible name contains "look at this").
    await user.click(screen.getByRole("button", { name: /look at this/i }))
    // image_url link (non-data) is rendered as an anchor.
    expect(await screen.findByText("https://example.com/cat.png")).toBeInTheDocument()
    // audio part shows format + size.
    expect(await screen.findByText(/audio \(wav\)/i)).toBeInTheDocument()
    // unknown part: details with a red summary.
    expect(await screen.findByText(/unknown part/i)).toBeInTheDocument()
  })

  it("renders the Tools section with strict mode and parameters", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: { name: "calc", description: "adds", parameters: { type: "object" }, strict: true },
      }],
      max_tokens: 1,
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    await user.click(screen.getByRole("button", { name: /tools \(1\)/i }))
    expect(await screen.findByText("calc")).toBeInTheDocument()
    expect(await screen.findByText("adds")).toBeInTheDocument()
    expect(await screen.findByText("strict")).toBeInTheDocument()
  })

  it("renders the Parameters section with sampling rows and metadata", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 200,
      temperature: 0.4,
      top_p: 0.9,
      n: 2,
      seed: 42,
      stream: false,
      stop: ["\n"],
      tool_choice: "auto",
      parallel_tool_calls: true,
      frequency_penalty: 0.5,
      presence_penalty: -0.5,
      logprobs: true,
      top_logprobs: 5,
      service_tier: "default",
      user: "u-1",
      store: true,
      metadata: { foo: "bar" },
      logit_bias: { "123": -1.5 },
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    await user.click(screen.getByRole("button", { name: /parameters/i }))
    expect(await screen.findByText("0.4")).toBeInTheDocument()
    expect(await screen.findByText("42")).toBeInTheDocument()
    expect(await screen.findByText(/u-1/i)).toBeInTheDocument()
    // metadata is rendered as a pre with the JSON
    expect(await screen.findByText(/"foo"/)).toBeInTheDocument()
  })

  it("renders a json_schema response_format section with strict + description", () => {
    const req = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "MySchema",
          strict: true,
          description: "user schema",
          schema: { type: "object" },
        },
      },
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText(/JSON schema:/i)).toBeInTheDocument()
    expect(screen.getByText("MySchema")).toBeInTheDocument()
    expect(screen.getByText("strict")).toBeInTheDocument()
    expect(screen.getByText("user schema")).toBeInTheDocument()
  })

  it("renders a text response_format section", () => {
    const req = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      response_format: { type: "text" },
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText(/Response format/i)).toBeInTheDocument()
    expect(screen.getByText("text")).toBeInTheDocument()
  })

  it("renders a json_object response_format section", () => {
    const req = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      response_format: { type: "json_object" },
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText("json_object")).toBeInTheDocument()
  })

  it("renders an unknown response_format section with a red warning", () => {
    const req = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      response_format: { type: "mystery" },
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText(/unknown response_format/i)).toBeInTheDocument()
  })

  it("renders a usage card with cached / reasoning / fingerprint / service_tier rows", () => {
    const req = JSON.stringify({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 1,
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      system_fingerprint: "fp_x",
      service_tier: "priority",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: {
        prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText("fp_x")).toBeInTheDocument()
    expect(screen.getByText("priority")).toBeInTheDocument()
    // cached and reasoning labels (5 and 7) appear; both are also numbers elsewhere so just match labels
    expect(screen.getByText(/cached/i)).toBeInTheDocument()
    expect(screen.getByText(/reasoning/i)).toBeInTheDocument()
  })

  it("renders the no-choices notice in the ResponseCard path (full view)", () => {
    const req = JSON.stringify({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 1,
    })
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText(/No choices in response/i)).toBeInTheDocument()
  })
})
