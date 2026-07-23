import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import type { ToolIndex } from "@/lib/turn-index"
import { CallRendererDispatch, CallOutputDispatch, CallInputDispatch } from "./dispatch"

// ── request/response bodies per provider (minimal happy-path shapes) ──────
const anthropicReq = JSON.stringify({
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "What is 2+2?" }],
  max_tokens: 1024,
})
const anthropicRes = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4",
  content: [{ type: "text", text: "It is 4." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 6 },
})

const openaiChatReq = JSON.stringify({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 1024,
  temperature: 0.7,
  top_p: 1,
})
const openaiChatRes = JSON.stringify({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
})

const openaiResponsesReq = JSON.stringify({
  model: "gpt-4o",
  input: [{ type: "message", role: "user", content: "Hello" }],
})
const openaiResponsesRes = JSON.stringify({
  id: "resp_1",
  object: "response",
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi" }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
})

const geminiReq = JSON.stringify({
  contents: [{ role: "user", parts: [{ text: "Hello" }] }],
})
const geminiRes = JSON.stringify({
  candidates: [
    {
      content: { role: "model", parts: [{ text: "Hi" }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
})

const emptyToolIndex: ToolIndex = new Map()

describe("CallRendererDispatch — full detail view", () => {
  it("renders the anthropic view", () => {
    render(
      <CallRendererDispatch
        wireApi="anthropic"
        requestBody={anthropicReq}
        responseBody={anthropicRes}
        hasRequestBody
      />,
    )
    // assistant text rendered via Markdown.
    expect(screen.getByText(/It is 4/)).toBeInTheDocument()
  })

  it("renders the openai-chat view", () => {
    render(
      <CallRendererDispatch
        wireApi="openai-chat"
        requestBody={openaiChatReq}
        responseBody={openaiChatRes}
        hasRequestBody
      />,
    )
    expect(screen.getByText(/Hi there/)).toBeInTheDocument()
  })

  it("renders the openai-responses view", () => {
    render(
      <CallRendererDispatch
        wireApi="openai-responses"
        requestBody={openaiResponsesReq}
        responseBody={openaiResponsesRes}
        hasRequestBody
      />,
    )
    expect(screen.getByText("Hi")).toBeInTheDocument()
  })

  it("renders the gemini-aistudio view", () => {
    render(
      <CallRendererDispatch
        wireApi="gemini-aistudio"
        requestBody={geminiReq}
        responseBody={geminiRes}
        hasRequestBody
      />,
    )
    expect(screen.getByText("Hi")).toBeInTheDocument()
  })

  it("falls back to raw JSON for unknown wire_api", () => {
    render(
      <CallRendererDispatch
        wireApi="weird-api"
        requestBody={JSON.stringify({ hello: "world" })}
        responseBody={JSON.stringify({ ok: true })}
        hasRequestBody
      />,
    )
    expect(screen.getByText(/no renderer for wire_api "weird-api"/i)).toBeInTheDocument()
    // pretty-printed request/response present.
    expect(screen.getByText(/"hello"/)).toBeInTheDocument()
    expect(screen.getByText(/"ok"/)).toBeInTheDocument()
  })

  it("shows the not-captured notice when hasRequestBody is false (fallback)", () => {
    render(
      <CallRendererDispatch
        wireApi="weird-api"
        requestBody={null}
        responseBody={JSON.stringify({ ok: true })}
        hasRequestBody={false}
      />,
    )
    expect(screen.getByText(/Request body not captured/i)).toBeInTheDocument()
  })
})

describe("CallOutputDispatch — output-only", () => {
  it("renders anthropic output blocks", () => {
    render(
      <CallOutputDispatch
        wireApi="anthropic"
        agentKind={null}
        responseBody={anthropicRes}
        toolIndex={emptyToolIndex}
        callId="call-1"
      />,
    )
    expect(screen.getByText(/It is 4/)).toBeInTheDocument()
  })

  it("renders openai-chat output blocks", () => {
    render(
      <CallOutputDispatch
        wireApi="openai-chat"
        agentKind={null}
        responseBody={openaiChatRes}
        toolIndex={emptyToolIndex}
        callId="call-1"
      />,
    )
    expect(screen.getByText(/Hi there/)).toBeInTheDocument()
  })

  it("renders openai-responses output blocks", () => {
    render(
      <CallOutputDispatch
        wireApi="openai-responses"
        agentKind={null}
        responseBody={openaiResponsesRes}
        toolIndex={emptyToolIndex}
        callId="call-1"
      />,
    )
    expect(screen.getByText("Hi")).toBeInTheDocument()
  })

  it("renders gemini output blocks", () => {
    render(
      <CallOutputDispatch
        wireApi="gemini-aistudio"
        agentKind={null}
        responseBody={geminiRes}
        toolIndex={emptyToolIndex}
        callId="call-1"
      />,
    )
    expect(screen.getByText("Hi")).toBeInTheDocument()
  })

  it("renders the no-output-renderer notice for unknown wire_api", () => {
    render(
      <CallOutputDispatch
        wireApi="weird-api"
        agentKind={null}
        responseBody="{}"
        toolIndex={emptyToolIndex}
        callId="call-1"
      />,
    )
    expect(screen.getByText(/No output renderer for wire_api/i)).toBeInTheDocument()
  })
})

describe("CallInputDispatch — input-only", () => {
  it("renders anthropic input blocks", () => {
    render(
      <CallInputDispatch
        wireApi="anthropic"
        agentKind={null}
        requestBody={anthropicReq}
        toolIndex={emptyToolIndex}
      />,
    )
    expect(screen.getByText("What is 2+2?")).toBeInTheDocument()
  })

  it("renders openai-chat input blocks", () => {
    render(
      <CallInputDispatch
        wireApi="openai-chat"
        agentKind={null}
        requestBody={openaiChatReq}
        toolIndex={emptyToolIndex}
      />,
    )
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })

  it("renders openai-responses input blocks", () => {
    render(
      <CallInputDispatch
        wireApi="openai-responses"
        agentKind={null}
        requestBody={openaiResponsesReq}
        toolIndex={emptyToolIndex}
      />,
    )
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })

  it("renders gemini input blocks", () => {
    render(
      <CallInputDispatch
        wireApi="gemini-aistudio"
        agentKind={null}
        requestBody={geminiReq}
        toolIndex={emptyToolIndex}
      />,
    )
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })

  it("renders nothing for unknown wire_api", () => {
    const { container } = render(
      <CallInputDispatch
        wireApi="weird-api"
        agentKind={null}
        requestBody="{}"
        toolIndex={emptyToolIndex}
      />,
    )
    expect(container.innerHTML).toBe("")
  })
})
