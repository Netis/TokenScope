import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolIndex } from "@/lib/turn-index"
import {
  AnthropicCallView,
  AnthropicOutputBlocks,
  AnthropicInputBlocks,
  anthropicParseForOutput,
  anthropicParseForInput,
} from "./anthropic"
import type {
  AnthropicResponse,
} from "@/lib/wire-apis/anthropic/types"
import type { CallOverlay } from "./overlays/types"

// ── shared fixtures ─────────────────────────────────────────────────────────

const emptyToolIndex: ToolIndex = new Map()

const overlay: CallOverlay = {
  UserMessageContent: ({ text }) => <div data-testid="overlay-user">{text}</div>,
  ToolResultContent: ({ content, isError }) => (
    <div data-testid="overlay-toolresult" data-error={String(isError)}>{content}</div>
  ),
}

// ToolIndex carrying a matching resolution so ToolUsePointer renders "healthy".
function toolIndexWithResolution(toolUseId: string): ToolIndex {
  const idx: ToolIndex = new Map()
  idx.set(toolUseId, {
    origin: { call_sequence: 1, call_id: "call-1", tool_name: "search", args_json: "{}" },
    resolution: {
      call_sequence: 2,
      call_id: "call-2",
      is_error: false,
      size_bytes: 12,
      content: "result-body",
    },
  })
  return idx
}

// ── parse helpers ──────────────────────────────────────────────────────────

describe("anthropicParseForOutput", () => {
  it("parses a happy-path response body", () => {
    const res = JSON.stringify({
      id: "m_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    })
    const { response } = anthropicParseForOutput(null, res)
    expect(response.content).toHaveLength(1)
    expect(response.content[0]).toMatchObject({ type: "text", text: "hi" })
    expect(response.stop_reason).toBe("end_turn")
    expect(response.usage.input_tokens).toBe(1)
  })

  it("returns an empty response when body is null", () => {
    const { response } = anthropicParseForOutput(null, null)
    expect(response.content).toEqual([])
    expect(response.usage.input_tokens).toBeNull()
  })
})

describe("anthropicParseForInput", () => {
  it("returns empty deltas when requestBody is null", () => {
    expect(anthropicParseForInput(null)).toEqual({ toolResults: [], extraUserText: null })
  })

  it("returns empty deltas when no user message exists", () => {
    const req = JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] })
    expect(anthropicParseForInput(req)).toEqual({ toolResults: [], extraUserText: null })
  })

  it("extracts tool_result blocks and additional user text from the last user message", () => {
    const req = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "first user" }] },
        { role: "assistant", content: [{ type: "text", text: "ask" }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "result body", is_error: false },
            { type: "tool_result", tool_use_id: "tu_2", content: [{ type: "text", text: "nested" }], is_error: true },
            { type: "text", text: "and a follow-up" },
          ],
        },
      ],
    })
    const parsed = anthropicParseForInput(req)
    expect(parsed.toolResults).toEqual([
      { tool_use_id: "tu_1", content: "result body", is_error: false },
      { tool_use_id: "tu_2", content: JSON.stringify([{ type: "text", text: "nested" }], null, 2), is_error: true },
    ])
    expect(parsed.extraUserText).toBe("and a follow-up")
  })
})

// ── AnthropicOutputBlocks ───────────────────────────────────────────────────

describe("AnthropicOutputBlocks", () => {
  it("renders the empty-state notice when content is empty", () => {
    const response: AnthropicResponse = {
      id: null, model: null, role: null, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    }
    render(<AnthropicOutputBlocks response={response} />)
    expect(screen.getByText(/No response content/i)).toBeInTheDocument()
  })

  it("renders text + tool_use + thinking + tool_result blocks", () => {
    const response: AnthropicResponse = {
      id: "m",
      model: "claude",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [
        { type: "thinking", thinking: "let me think", signature: "sig1234567890" },
        { type: "text", text: "answering" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
        { type: "tool_result", tool_use_id: "tu_2", content: "result text", is_error: false },
        { type: "tool_result", tool_use_id: "tu_3", content: "errored", is_error: true },
      ],
    }
    render(<AnthropicOutputBlocks response={response} ctx={{ toolIndex: emptyToolIndex, callId: "call-1" }} />)
    // thinking summary present (size label), expandable
    expect(screen.getByText(/💭 thinking/i)).toBeInTheDocument()
    expect(screen.getByText(/answering/)).toBeInTheDocument()
    // tool_use block markers
    expect(screen.getByText("tool_use")).toBeInTheDocument()
    expect(screen.getByText("search")).toBeInTheDocument()
    // tool_result blocks
    expect(screen.getAllByText("tool_result")).toHaveLength(2)
    expect(screen.getByText("result text")).toBeInTheDocument()
    expect(screen.getByText("errored")).toBeInTheDocument()
    // is_error label rendered
    expect(screen.getByText("true")).toBeInTheDocument()
    // "result not captured" because the toolUseId "tu_1" isn't in the index
    expect(screen.getByText(/result not captured/i)).toBeInTheDocument()
  })

  it("renders a healthy ToolUsePointer when the tool_index has a matching resolution", () => {
    const response: AnthropicResponse = {
      id: "m", model: null, role: null, stop_reason: "tool_use", stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [{ type: "tool_use", id: "tu_match", name: "search", input: { x: 1 } }],
    }
    render(
      <AnthropicOutputBlocks
        response={response}
        ctx={{ toolIndex: toolIndexWithResolution("tu_match"), callId: "call-1" }}
      />,
    )
    expect(screen.getByText(/result in #2 ✓/)).toBeInTheDocument()
  })

  it("renders an image block (base64) and (url)", () => {
    const response: AnthropicResponse = {
      id: null, model: null, role: null, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "Zm9v" },
        },
        { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
      ],
    }
    render(<AnthropicOutputBlocks response={response} />)
    expect(screen.getByText(/image \(image\/png\)/i)).toBeInTheDocument()
    expect(screen.getByText("https://example.com/cat.png")).toBeInTheDocument()
  })

  it("renders a document block with optional title", () => {
    const response: AnthropicResponse = {
      id: null, model: null, role: null, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [{ type: "document", source: {}, title: "report.pdf" }],
    }
    render(<AnthropicOutputBlocks response={response} />)
    expect(screen.getByText(/document — report\.pdf/i)).toBeInTheDocument()
  })

  it("renders a redacted_thinking block", () => {
    const response: AnthropicResponse = {
      id: null, model: null, role: null, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [{ type: "redacted_thinking", data: "deadbeef" }],
    }
    render(<AnthropicOutputBlocks response={response} />)
    expect(screen.getByText(/redacted thinking/i)).toBeInTheDocument()
  })

  it("renders an unknown block inside a foldable details", () => {
    const response: AnthropicResponse = {
      id: null, model: null, role: null, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [{ type: "unknown", raw: { foo: "bar" } }],
    }
    render(<AnthropicOutputBlocks response={response} />)
    expect(screen.getByText(/unknown block/i)).toBeInTheDocument()
  })

  it("expands a thinking block on click", async () => {
    const user = userEvent.setup()
    const response: AnthropicResponse = {
      id: null, model: null, role: null, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [{ type: "thinking", thinking: "hidden thoughts", signature: "sig12345" }],
    }
    render(<AnthropicOutputBlocks response={response} />)
    expect(screen.queryByText("hidden thoughts")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /thinking/i }))
    expect(await screen.findByText("hidden thoughts")).toBeInTheDocument()
  })

  it("uses the overlay ToolResultContent renderer for tool_result blocks when provided", () => {
    const response: AnthropicResponse = {
      id: null, model: null, role: null, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      content: [{ type: "tool_result", tool_use_id: "tu_x", content: "payload", is_error: false }],
    }
    render(<AnthropicOutputBlocks response={response} overlay={overlay} />)
    expect(screen.getByTestId("overlay-toolresult")).toHaveAttribute("data-error", "false")
    expect(screen.getByText("payload")).toBeInTheDocument()
  })
})

// ── AnthropicInputBlocks ────────────────────────────────────────────────────

describe("AnthropicInputBlocks", () => {
  it("shows the no-deltas notice when parsed is empty", () => {
    render(
      <AnthropicInputBlocks
        parsed={{ toolResults: [], extraUserText: null }}
        ctx={{ toolIndex: emptyToolIndex }}
      />,
    )
    expect(screen.getByText(/No input deltas/i)).toBeInTheDocument()
  })

  it("renders tool_results and extraUserText, classifying orphan and error states", () => {
    const parsed = {
      toolResults: [
        { tool_use_id: "tu_orphan", content: "no parent", is_error: false },
        { tool_use_id: "tu_err", content: "boom", is_error: true },
      ],
      extraUserText: "extra user message",
    }
    render(<AnthropicInputBlocks parsed={parsed} ctx={{ toolIndex: emptyToolIndex }} />)
    // two tool_result headers (one as "error", one as "tool_result")
    expect(screen.getAllByText(/⤷/)).toHaveLength(2)
    expect(screen.getByText("no parent")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.getByText(/extra user message/i)).toBeInTheDocument()
  })

  it("renders a healthy ToolResultBackLink when the origin is present", () => {
    const parsed = {
      toolResults: [
        { tool_use_id: "tu_match", content: "ok", is_error: false },
      ],
      extraUserText: null,
    }
    render(
      <AnthropicInputBlocks
        parsed={parsed}
        ctx={{ toolIndex: toolIndexWithResolution("tu_match") }}
      />,
    )
    // ToolResultBackLink renders "→ from #1 …" when the origin is present
    expect(screen.getByText(/from #1/i)).toBeInTheDocument()
  })

  it("uses the overlay ToolResultContent renderer when provided", () => {
    const parsed = {
      toolResults: [{ tool_use_id: "tu", content: "body", is_error: false }],
      extraUserText: null,
    }
    render(
      <AnthropicInputBlocks
        parsed={parsed}
        ctx={{ toolIndex: emptyToolIndex }}
        overlay={overlay}
      />,
    )
    expect(screen.getByTestId("overlay-toolresult")).toBeInTheDocument()
  })
})

// ── AnthropicCallView (full detail) ─────────────────────────────────────────

describe("AnthropicCallView", () => {
  it("shows the not-captured notice when hasRequestBody is false", () => {
    render(
      <AnthropicCallView requestBody={null} responseBody={null} hasRequestBody={false} />,
    )
    expect(screen.getByText(/Request body not captured/i)).toBeInTheDocument()
  })

  it("renders the cache-control badge when system blocks have cache markers", () => {
    const req = JSON.stringify({
      model: "claude",
      system: [
        { type: "text", text: "cached sys", cache_control: { type: "ephemeral" } },
        { type: "text", text: "other" },
      ],
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    })
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    render(<AnthropicCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText(/cache marker/i)).toBeInTheDocument()
    expect(screen.getByText("hello")).toBeInTheDocument()
  })

  it("renders system, messages, tools, parameters sections and expand them", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "claude-sonnet",
      system: "be helpful",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "calc", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "42", is_error: false }] },
      ],
      tools: [{ name: "calc", description: "adds", input_schema: { type: "object" } }],
      max_tokens: 1024,
      temperature: 0.5,
      stop_sequences: ["\n"],
      tool_choice: { type: "tool", name: "calc" },
      metadata: { user_id: "u1" },
    })
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    })
    render(<AnthropicCallView requestBody={req} responseBody={res} hasRequestBody />)
    // system section header
    expect(screen.getByRole("button", { name: /system/i })).toBeInTheDocument()
    // messages section header
    expect(screen.getByRole("button", { name: /messages \(3\)/i })).toBeInTheDocument()
    // tools section header
    expect(screen.getByRole("button", { name: /tools \(1\)/i })).toBeInTheDocument()
    // parameters section header
    expect(screen.getByRole("button", { name: /parameters/i })).toBeInTheDocument()
    // expand system
    await user.click(screen.getByRole("button", { name: /system/i }))
    expect(await screen.findByText("be helpful")).toBeInTheDocument()
    // expand tools
    await user.click(screen.getByRole("button", { name: /tools \(1\)/i }))
    expect(await screen.findByText("calc")).toBeInTheDocument()
    expect(await screen.findByText("adds")).toBeInTheDocument()
    // expand parameters
    await user.click(screen.getByRole("button", { name: /parameters/i }))
    expect(await screen.findByText("claude-sonnet")).toBeInTheDocument()
    expect(await screen.findByText("0.5")).toBeInTheDocument()
    expect(await screen.findByText(/u1/i)).toBeInTheDocument()
    // expand messages and open the user/assistant rows
    await user.click(screen.getByRole("button", { name: /messages \(3\)/i }))
    // there are now 3 message-row buttons (each row header is a button)
    const calcCells = screen.getAllByText("calc")
    expect(calcCells.length).toBeGreaterThan(0)
  })

  it("renders usage card with cache hit ratio when cache_read_input_tokens > 0", () => {
    const req = JSON.stringify({ model: "c", messages: [{ role: "user", content: "hi" }], max_tokens: 1 })
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "text", text: "x" }],
      stop_reason: "max_tokens",
      stop_sequence: "stop-seq-1",
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    })
    render(<AnthropicCallView requestBody={req} responseBody={res} hasRequestBody />)
    // cache hit ratio appears: 50 / (100 + 50 + 0) = 33%
    expect(screen.getByText("33%")).toBeInTheDocument()
    // stop_sequence echoed
    expect(screen.getByText(/seq: stop-seq-1/i)).toBeInTheDocument()
  })

  it("renders various stop_reason badges", () => {
    const reasons = ["end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal", "weird"]
    for (const r of reasons) {
      const res = JSON.stringify({
        id: "m", type: "message", role: "assistant",
        content: [{ type: "text", text: "x" }],
        stop_reason: r,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      const req = JSON.stringify({ model: "c", messages: [{ role: "user", content: "hi" }], max_tokens: 1 })
      const { unmount } = render(<AnthropicCallView requestBody={req} responseBody={res} hasRequestBody />)
      expect(screen.getByText(r)).toBeInTheDocument()
      unmount()
    }
  })

  it("uses the overlay UserMessageContent renderer for user text blocks", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({ model: "c", messages: [{ role: "user", content: "hi there" }], max_tokens: 1 })
    const res = JSON.stringify({
      id: "m", type: "message", role: "assistant",
      content: [{ type: "text", text: "x" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    render(
      <AnthropicCallView requestBody={req} responseBody={res} hasRequestBody overlay={overlay} />,
    )
    // The assistant text block is rendered through UserMessageContent in the Output
    // section immediately (no expansion needed), surfacing the overlay.
    expect(screen.getByTestId("overlay-user")).toBeInTheDocument()
    // Now expand the Messages section and the user row to surface the user-side overlay.
    await user.click(screen.getByRole("button", { name: /messages \(1\)/i }))
    await user.click(screen.getByRole("button", { name: /hi there/i }))
    // Two overlay-user elements now: assistant text "x" + user text "hi there".
    expect(await screen.findAllByTestId("overlay-user")).toHaveLength(2)
  })
})
