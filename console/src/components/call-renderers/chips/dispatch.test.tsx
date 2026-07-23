import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import { CallChipDispatch, GanttCallTypeIcon } from "./dispatch"
import { AnthropicCallChip } from "./anthropic-chip"
import { OpenAiChatCallChip } from "./openai-chat-chip"
import { OpenAiResponsesCallChip } from "./openai-responses-chip"

// ── Anthropic chip ──────────────────────────────────────────────────────────

describe("AnthropicCallChip", () => {
  it("shows 'final' badge when callType is final", () => {
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "text", text: "answering" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    render(<AnthropicCallChip responseBody={res} callType="final" />)
    expect(screen.getByText("final")).toBeInTheDocument()
  })

  it("shows 'text' badge when there is no tool_use or thinking block, no cache hit", () => {
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "text", text: "answering" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    render(<AnthropicCallChip responseBody={res} callType="text" />)
    expect(screen.getByText("text")).toBeInTheDocument()
  })

  it("shows tool name(s) + more count for tool_call", () => {
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [
        { type: "tool_use", id: "tu_1", name: "search", input: {} },
        { type: "tool_use", id: "tu_2", name: "calc", input: {} },
        { type: "tool_use", id: "tu_3", name: "extra", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    render(<AnthropicCallChip responseBody={res} callType="tool_call" />)
    // toolNames.slice(0, 2) → "search, calc"; more = 1
    expect(screen.getByText(/search, calc/)).toBeInTheDocument()
    expect(screen.getByText("+1")).toBeInTheDocument()
  })

  it("shows thinking badge when a thinking block is present", () => {
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "thinking", thinking: "let me think" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    render(<AnthropicCallChip responseBody={res} callType="text" />)
    expect(screen.getByTitle("response contains thinking")).toBeInTheDocument()
  })

  it("shows cache badge when cache_read_input_tokens > 0", () => {
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "text", text: "answering" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100 },
    })
    render(<AnthropicCallChip responseBody={res} callType="text" />)
    expect(screen.getByTitle("prompt cache hit")).toBeInTheDocument()
  })

  it("renders without crashing when responseBody is null", () => {
    render(<AnthropicCallChip responseBody={null} callType="text" />)
    expect(screen.getByText("text")).toBeInTheDocument()
  })
})

// ── OpenAI Chat chip ────────────────────────────────────────────────────────

describe("OpenAiChatCallChip", () => {
  it("shows 'final' badge for final call type", () => {
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallChip responseBody={res} callType="final" />)
    expect(screen.getByText("final")).toBeInTheDocument()
  })

  it("shows tool names for tool_call", () => {
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "search", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "calc", arguments: "{}" } },
            { id: "tc_3", type: "function", function: { name: "extra", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallChip responseBody={res} callType="tool_call" />)
    expect(screen.getByText(/search, calc/)).toBeInTheDocument()
    expect(screen.getByText("+1")).toBeInTheDocument()
  })

  it("shows reasoning badge when reasoning_content is present", () => {
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "x", reasoning_content: "thinking" },
        finish_reason: "stop",
        logprobs: null,
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallChip responseBody={res} callType="text" />)
    expect(screen.getByTitle("response has reasoning_content")).toBeInTheDocument()
  })

  it("shows logprobs badge when logprobs are present", () => {
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "x" },
        finish_reason: "stop",
        logprobs: { content: [{ token: "x", logprob: -0.1, bytes: null, top_logprobs: [] }] },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiChatCallChip responseBody={res} callType="text" />)
    expect(screen.getByTitle("response includes logprobs")).toBeInTheDocument()
  })

  it("renders 'text' badge when responseBody is null", () => {
    render(<OpenAiChatCallChip responseBody={null} callType="text" />)
    expect(screen.getByText("text")).toBeInTheDocument()
  })
})

// ── OpenAI Responses chip ──────────────────────────────────────────────────

describe("OpenAiResponsesCallChip", () => {
  it("shows 'final' badge for final call type", () => {
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallChip responseBody={res} callType="final" />)
    expect(screen.getByText("final")).toBeInTheDocument()
  })

  it("shows tool names + special badges for tool_call with multiple tool/special kinds", () => {
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [
        { type: "function_call", call_id: "fc_1", name: "search", arguments: "{}" },
        { type: "function_call", call_id: "fc_2", name: "calc", arguments: "{}" },
        { type: "function_call", call_id: "fc_3", name: "extra", arguments: "{}" },
        { type: "file_search_call", id: "fs_1" },
        { type: "web_search_call", id: "ws_1" },
        { type: "mcp_call", id: "mcp_1", name: "tool", arguments: "{}" },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallChip responseBody={res} callType="tool_call" />)
    expect(screen.getByText(/search, calc/)).toBeInTheDocument()
    expect(screen.getByText("+1")).toBeInTheDocument()
    expect(screen.getByTitle("file_search")).toBeInTheDocument()
    expect(screen.getByTitle("web_search")).toBeInTheDocument()
    expect(screen.getByTitle("mcp")).toBeInTheDocument()
  })

  it("shows tool_call badge even without function_call items (special kinds only)", () => {
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "file_search_call", id: "fs_1" }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallChip responseBody={res} callType="tool_call" />)
    expect(screen.getByTitle("file_search")).toBeInTheDocument()
  })

  it("shows reasoning badge when reasoning items are present", () => {
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "reasoning", id: "rsn_1", summary: [] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallChip responseBody={res} callType="text" />)
    expect(screen.getByTitle("response contains reasoning")).toBeInTheDocument()
  })

  it("renders 'text' badge when responseBody is null", () => {
    render(<OpenAiResponsesCallChip responseBody={null} callType="text" />)
    expect(screen.getByText("text")).toBeInTheDocument()
  })
})

// ── CallChipDispatch ───────────────────────────────────────────────────────

describe("CallChipDispatch", () => {
  it("routes anthropic to AnthropicCallChip", () => {
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "search", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    render(
      <CallChipDispatch
        wireApi="anthropic"
        callId="call-1"
        responseBody={res}
        finalCallId="call-2"
      />,
    )
    // tool_call classification: tool name appears
    expect(screen.getByText(/search/)).toBeInTheDocument()
  })

  it("routes openai-chat to OpenAiChatCallChip", () => {
    const res = JSON.stringify({
      id: "y", object: "chat.completion", model: "gpt-4o",
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "tc_1", type: "function", function: { name: "search", arguments: "{}" } }] },
        finish_reason: "tool_calls",
        logprobs: null,
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    render(
      <CallChipDispatch
        wireApi="openai-chat"
        callId="call-1"
        responseBody={res}
        finalCallId={null}
      />,
    )
    expect(screen.getByText(/search/)).toBeInTheDocument()
  })

  it("routes openai-responses to OpenAiResponsesCallChip", () => {
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "function_call", call_id: "fc_1", name: "search", arguments: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(
      <CallChipDispatch
        wireApi="openai-responses"
        callId="call-1"
        responseBody={res}
        finalCallId={null}
      />,
    )
    expect(screen.getByText(/search/)).toBeInTheDocument()
  })

  it("falls back to GenericTypeChip for unknown wire_api (final)", () => {
    render(
      <CallChipDispatch
        wireApi="unknown-wire"
        callId="call-final"
        responseBody="{}"
        finalCallId="call-final"
      />,
    )
    // callType = final because callId === finalCallId
    expect(screen.getByText("final")).toBeInTheDocument()
  })

  it("falls back to GenericTypeChip for unknown wire_api (tool_call via gemini tool_use)", () => {
    // Unknown wire_api can't classify, but finalCallId mismatch means callType defaults to "text".
    // To force a tool_call chip, we'd need a known wire_api. So check the tool variant via gemini-aistudio.
    const res = JSON.stringify({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{ functionCall: { name: "search", args: {} } }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    })
    render(
      <CallChipDispatch
        wireApi="gemini-aistudio"
        callId="call-1"
        responseBody={res}
        finalCallId={null}
      />,
    )
    // gemini-aistudio has no dedicated chip → falls back to GenericTypeChip
    // callType for gemini with functionCall is tool_call
    expect(screen.getByText("tool")).toBeInTheDocument()
  })

  it("falls back to GenericTypeChip for unknown wire_api (text)", () => {
    render(
      <CallChipDispatch
        wireApi="weird-api"
        callId="call-1"
        responseBody="{}"
        finalCallId={null}
      />,
    )
    expect(screen.getByText("text")).toBeInTheDocument()
  })
})

// ── GanttCallTypeIcon ──────────────────────────────────────────────────────

describe("GanttCallTypeIcon", () => {
  it("renders a Wrench icon for tool_call", () => {
    const { container } = render(<GanttCallTypeIcon callType="tool_call" />)
    // lucide-react Wrench renders an SVG; just assert an SVG is present
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("renders a Target icon for final", () => {
    const { container } = render(<GanttCallTypeIcon callType="final" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("renders a MessageSquare icon for text", () => {
    const { container } = render(<GanttCallTypeIcon callType="text" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
