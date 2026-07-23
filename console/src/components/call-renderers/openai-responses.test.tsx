import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolIndex } from "@/lib/turn-index"
import {
  OpenAiResponsesCallView,
  OpenAiResponsesOutputBlocks,
  OpenAiResponsesInputBlocks,
  openaiResponsesParseForOutput,
  openaiResponsesParseForInput,
} from "./openai-responses"
import type {
  ResponsesResponse,
} from "@/lib/wire-apis/openai-responses/types"
import type { CallOverlay } from "./overlays/types"

// ── shared fixtures ─────────────────────────────────────────────────────────

const emptyToolIndex: ToolIndex = new Map()

const overlay: CallOverlay = {
  UserMessageContent: ({ text }) => <div data-testid="overlay-user">{text}</div>,
  ToolResultContent: ({ content, isError }) => (
    <div data-testid="overlay-toolresult" data-error={String(isError)}>{content}</div>
  ),
}

function toolIndexWithResolution(callId: string): ToolIndex {
  const idx: ToolIndex = new Map()
  idx.set(callId, {
    origin: { call_sequence: 1, call_id: "call-1", tool_name: "search", args_json: "{}" },
    resolution: {
      call_sequence: 2, call_id: "call-2", is_error: false, size_bytes: 7, content: "ok",
    },
  })
  return idx
}

// ── parse helpers ──────────────────────────────────────────────────────────

describe("openaiResponsesParseForOutput", () => {
  it("parses a happy-path response", () => {
    const res = JSON.stringify({
      id: "resp_1", object: "response", model: "gpt-4o", status: "completed",
      output: [
        { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })
    const { response } = openaiResponsesParseForOutput(null, res)
    expect(response.output).toHaveLength(1)
    expect(response.output[0].kind).toBe("message")
    expect(response.status).toBe("completed")
  })

  it("returns an empty response when body is null", () => {
    const { response } = openaiResponsesParseForOutput(null, null)
    expect(response.output).toEqual([])
  })
})

describe("openaiResponsesParseForInput", () => {
  it("returns empty deltas when requestBody is null", () => {
    expect(openaiResponsesParseForInput(null)).toEqual({ toolResults: [], extraUserText: null })
  })

  it("returns empty deltas when there are no items", () => {
    const req = JSON.stringify({ input: [] })
    expect(openaiResponsesParseForInput(req)).toEqual({ toolResults: [], extraUserText: null })
  })

  it("extracts function_call_output and trailing user text after the last function_call", () => {
    const req = JSON.stringify({
      input: [
        { type: "message", role: "user", content: "first" },
        { type: "function_call", call_id: "fc_1", name: "do", arguments: "{}" },
        { type: "function_call_output", call_id: "fc_1", output: "result text" },
        { type: "function_call_output", call_id: "fc_2", output: { structured: "yes" } },
        { type: "message", role: "user", content: "next round" },
      ],
    })
    const parsed = openaiResponsesParseForInput(req)
    expect(parsed.toolResults).toEqual([
      { call_id: "fc_1", content: "result text" },
      { call_id: "fc_2", content: JSON.stringify({ structured: "yes" }, null, 2) },
    ])
    expect(parsed.extraUserText).toBe("next round")
  })

  it("extracts extraUserText from multipart user messages", () => {
    const req = JSON.stringify({
      input: [
        { type: "function_call", call_id: "fc_1", name: "do", arguments: "{}" },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "hello " },
            { type: "input_image", image_url: "https://example.com/img.png" },
            { type: "input_text", text: "world" },
          ],
        },
      ],
    })
    const parsed = openaiResponsesParseForInput(req)
    expect(parsed.toolResults).toEqual([])
    expect(parsed.extraUserText).toBe("hello world")
  })
})

// ── OpenAiResponsesOutputBlocks ─────────────────────────────────────────────

describe("OpenAiResponsesOutputBlocks", () => {
  it("renders the no-items notice when output is empty", () => {
    const response: ResponsesResponse = {
      id: null, model: null, status: null, output: [], usage: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, reasoning_tokens: null },
      output_text_aggregated: "",
    }
    render(<OpenAiResponsesOutputBlocks response={response} />)
    expect(screen.getByText(/No response items/i)).toBeInTheDocument()
  })

  it("renders an inline assistant message (not collapsible)", () => {
    const response: ResponsesResponse = {
      id: "r", model: null, status: "completed", output: [
        { kind: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, reasoning_tokens: null },
      output_text_aggregated: "hello",
    }
    render(<OpenAiResponsesOutputBlocks response={response} />)
    expect(screen.getByText("hello")).toBeInTheDocument()
  })

  it("renders function_call, function_call_output, and reasoning items", async () => {
    const user = userEvent.setup()
    const response: ResponsesResponse = {
      id: "r", model: null, status: "completed", output: [
        { kind: "reasoning", id: "rsn_1", summary: ["thinking..."], encrypted_content: "enc123", status: "completed" },
        { kind: "function_call", call_id: "fc_1", name: "search", arguments: "{\"q\":\"x\"}", status: "completed" },
        { kind: "function_call_output", call_id: "fc_1", output: "result body" },
      ],
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, reasoning_tokens: null },
      output_text_aggregated: "",
    }
    render(
      <OpenAiResponsesOutputBlocks
        response={response}
        ctx={{ toolIndex: emptyToolIndex, callId: "call-1" }}
      />,
    )
    // function_call row header includes "search" name
    expect(screen.getByText(/search/)).toBeInTheDocument()
    // reasoning row header
    expect(screen.getAllByText(/reasoning/i).length).toBeGreaterThan(0)

    // open the function_call row to surface name/call_id
    await user.click(screen.getByText(/search/).closest("button")!)
    // function_call label inside the expanded row is uppercase "function_call"
    expect(await screen.findAllByText(/^function_call$/i)).not.toHaveLength(0)
    // call_id renders
    expect((await screen.findAllByText("fc_1")).length).toBeGreaterThan(0)
    // ToolUsePointer renders "result not captured" since the toolIndex is empty
    expect(await screen.findByText(/result not captured/i)).toBeInTheDocument()
  })

  it("renders a healthy ToolUsePointer when the tool_index has a matching resolution", async () => {
    const user = userEvent.setup()
    const response: ResponsesResponse = {
      id: "r", model: null, status: "completed", output: [
        { kind: "function_call", call_id: "fc_match", name: "search", arguments: "{}" },
      ],
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, reasoning_tokens: null },
      output_text_aggregated: "",
    }
    render(
      <OpenAiResponsesOutputBlocks
        response={response}
        ctx={{ toolIndex: toolIndexWithResolution("fc_match"), callId: "call-1" }}
      />,
    )
    await user.click(screen.getByText(/search/).closest("button")!)
    expect(await screen.findByText(/result in #2 ✓/)).toBeInTheDocument()
  })

  it("renders an unknown item in a folded row", async () => {
    const user = userEvent.setup()
    const response: ResponsesResponse = {
      id: "r", model: null, status: "completed", output: [
        { kind: "unknown", raw: { foo: "bar" } },
      ],
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, reasoning_tokens: null },
      output_text_aggregated: "",
    }
    render(<OpenAiResponsesOutputBlocks response={response} />)
    expect(screen.getByText("unrecognized item")).toBeInTheDocument()
    await user.click(screen.getByText("unrecognized item").closest("button")!)
    expect(await screen.findByText(/"foo"/)).toBeInTheDocument()
  })

  it("uses the overlay ToolResultContent for function_call_output items", async () => {
    const user = userEvent.setup()
    const response: ResponsesResponse = {
      id: "r", model: null, status: "completed", output: [
        { kind: "function_call_output", call_id: "fc_1", output: "payload" },
      ],
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, reasoning_tokens: null },
      output_text_aggregated: "",
    }
    render(<OpenAiResponsesOutputBlocks response={response} overlay={overlay} />)
    await user.click(screen.getByText(/fc_1/).closest("button")!)
    expect(await screen.findByTestId("overlay-toolresult")).toBeInTheDocument()
  })

  it("renders various status badges", () => {
    const statuses = ["completed", "incomplete", "failed", "cancelled", "in_progress", "weird"]
    for (const s of statuses) {
      // Wrap with UsageCard via the CallView, since OutputBlocks has no StatusBadge
      // directly. Use the full CallView with empty input + the response.
      const req = JSON.stringify({ model: "gpt-4o", input: [] })
      const res = JSON.stringify({
        id: "r", object: "response", model: "gpt-4o", status: s, output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
      const { unmount } = render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
      expect(screen.getByText(s)).toBeInTheDocument()
      unmount()
    }
  })
})

// ── OpenAiResponsesInputBlocks ──────────────────────────────────────────────

describe("OpenAiResponsesInputBlocks", () => {
  it("shows the no-deltas notice when parsed is empty", () => {
    render(
      <OpenAiResponsesInputBlocks
        parsed={{ toolResults: [], extraUserText: null }}
        ctx={{ toolIndex: emptyToolIndex }}
      />,
    )
    expect(screen.getByText(/No input deltas/i)).toBeInTheDocument()
  })

  it("renders tool_results and extraUserText", () => {
    const parsed = {
      toolResults: [{ call_id: "fc_1", content: "result" }],
      extraUserText: "next user",
    }
    render(<OpenAiResponsesInputBlocks parsed={parsed} ctx={{ toolIndex: emptyToolIndex }} />)
    expect(screen.getByText("result")).toBeInTheDocument()
    expect(screen.getByText(/next user/i)).toBeInTheDocument()
  })

  it("renders a healthy ToolResultBackLink when the origin is present", () => {
    const parsed = {
      toolResults: [{ call_id: "fc_match", content: "ok" }],
      extraUserText: null,
    }
    render(
      <OpenAiResponsesInputBlocks
        parsed={parsed}
        ctx={{ toolIndex: toolIndexWithResolution("fc_match") }}
      />,
    )
    expect(screen.getByText(/from #1/i)).toBeInTheDocument()
  })
})

// ── OpenAiResponsesCallView (full detail) ──────────────────────────────────

describe("OpenAiResponsesCallView", () => {
  it("shows the not-captured notice when hasRequestBody is false", () => {
    render(<OpenAiResponsesCallView requestBody={null} responseBody={null} hasRequestBody={false} />)
    expect(screen.getByText(/Request body not captured/i)).toBeInTheDocument()
  })

  it("renders the Instructions section when present", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: "hi" }],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    await user.click(screen.getByRole("button", { name: /instructions/i }))
    expect(await screen.findByText("be brief")).toBeInTheDocument()
  })

  it("renders input items (message, function_call_output, file_search, web_search, computer_call, mcp_call, reasoning, unknown)", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      input: [
        { type: "message", role: "user", content: "hi" },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "https://example.com/i.png", detail: "high" },
            { type: "input_file", filename: "doc.pdf", file_id: "fid_1", file_data: "AAAA" },
            { type: "refusal", refusal: "no" },
            { type: "mystery", foo: "bar" },
          ],
        },
        { type: "function_call", call_id: "fc_1", name: "search", arguments: "{}", status: "completed" },
        { type: "function_call_output", call_id: "fc_1", output: "ok" },
        {
          type: "reasoning",
          id: "rsn_1",
          summary: [{ type: "summary_text", text: "thinking hard" }],
          encrypted_content: "enc",
          status: "in_progress",
        },
        {
          type: "file_search_call",
          id: "fs_1",
          queries: ["foo", "bar"],
          results: [{ title: "r1" }],
          status: "in_progress",
        },
        {
          type: "web_search_call",
          id: "ws_1",
          status: "in_progress",
          action: { type: "search", query: "hi" },
        },
        {
          type: "computer_call",
          id: "cc_1",
          status: "in_progress",
          action: { type: "click", x: 10, y: 20 },
        },
        {
          type: "mcp_call",
          id: "mcp_1",
          server_label: "my_server",
          name: "tool_x",
          arguments: "{\"a\":1}",
          output: { ok: true },
          error: "boom",
          status: "in_progress",
        },
        { type: "mystery_kind", foo: "bar" },
      ],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    // Expand the Input section header. Its accessible name includes ItemTypeChips.
    await user.click(screen.getByRole("button", { name: /input/i }))
    // file_search row preview includes "foo"
    expect(screen.getByText("foo")).toBeInTheDocument()
    // the input section is open — the chips array shows the item kinds present.
    // Some kinds appear both as chips (ItemTypeChips) and as row badges; use
    // getAllByText and assert at least one match.
    expect(screen.getAllByText("function_call").length).toBeGreaterThan(0)
    expect(screen.getAllByText("function_call_output").length).toBeGreaterThan(0)
    expect(screen.getAllByText("reasoning").length).toBeGreaterThan(0)
    expect(screen.getAllByText("file_search_call").length).toBeGreaterThan(0)
    expect(screen.getAllByText("web_search_call").length).toBeGreaterThan(0)
    expect(screen.getAllByText("computer_call").length).toBeGreaterThan(0)
    expect(screen.getAllByText("mcp_call").length).toBeGreaterThan(0)
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0)
  })

  it("renders the Tools section with multiple tool types", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [
        { type: "function", name: "calc", description: "adds", parameters: { type: "object" }, strict: true },
        { type: "file_search", vector_store_ids: ["vs_1"] },
        { type: "mcp", server_label: "my_srv", server_url: "https://example.com/mcp" },
      ],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    await user.click(screen.getByRole("button", { name: /tools/i }))
    expect(await screen.findByText("calc")).toBeInTheDocument()
    expect(await screen.findByText(/adds/)).toBeInTheDocument()
    // vector_store_id is shown verbatim
    expect(await screen.findByText("vs_1")).toBeInTheDocument()
    // server_url is shown alongside the label (URL is unique — the label appears twice)
    expect(await screen.findByText("https://example.com/mcp")).toBeInTheDocument()
  })

  it("renders the Reasoning config section when present", () => {
    const req = JSON.stringify({
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: "hi" }],
      reasoning: { effort: "high", summary: "auto" },
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText(/Reasoning config/i)).toBeInTheDocument()
    expect(screen.getByText("high")).toBeInTheDocument()
    expect(screen.getByText("auto")).toBeInTheDocument()
  })

  it("renders the Parameters section with sampling + previous_response_id continuation", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: "hi" }],
      max_output_tokens: 200,
      temperature: 0.5,
      top_p: 0.9,
      stream: false,
      tool_choice: "auto",
      parallel_tool_calls: true,
      previous_response_id: "resp_prev",
      store: true,
      truncation: "auto",
      service_tier: "default",
      user: "u-1",
      metadata: { foo: "bar" },
      include: ["reasoning.encrypted_content"],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    await user.click(screen.getByRole("button", { name: /parameters/i }))
    expect(await screen.findByText(/continuation of/i)).toBeInTheDocument()
    expect(await screen.findByText("resp_prev")).toBeInTheDocument()
    expect(await screen.findByText("0.5")).toBeInTheDocument()
    expect(await screen.findByText(/u-1/i)).toBeInTheDocument()
    // metadata is rendered as a pre with the JSON
    expect(await screen.findByText(/"foo"/)).toBeInTheDocument()
    // include shown
    expect(await screen.findByText(/reasoning.encrypted_content/i)).toBeInTheDocument()
  })

  it("renders the usage card with cached/reasoning rows + id", () => {
    const req = JSON.stringify({
      model: "gpt-4o", input: [{ type: "message", role: "user", content: "hi" }],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 1, output_tokens: 2, total_tokens: 3,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText("r")).toBeInTheDocument()
    expect(screen.getByText(/cached_input/i)).toBeInTheDocument()
    expect(screen.getByText(/reasoning/i)).toBeInTheDocument()
  })

  it("renders assistant message content as parts (text and refusal) inline", () => {
    const req = JSON.stringify({
      model: "gpt-4o", input: [{ type: "message", role: "user", content: "hi" }],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{
        type: "message", role: "assistant",
        content: [
          { type: "output_text", text: "answering" },
          { type: "refusal", refusal: "blocked" },
        ],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    expect(screen.getByText("answering")).toBeInTheDocument()
    expect(screen.getByText(/blocked/i)).toBeInTheDocument()
  })

  it("renders unknown content parts inside a folded message", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "header text" },
          { type: "mystery_part", foo: "bar" },
        ],
      }],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    // expand input section, then expand the user row by matching on its preview text.
    await user.click(screen.getByRole("button", { name: /input/i }))
    await user.click(screen.getByText("header text").closest("button")!)
    // expanding reveals the unknown part inside the message
    expect(await screen.findByText(/unknown part/i)).toBeInTheDocument()
  })

  it("renders input_image parts (url + file_id + detail) and input_file parts", async () => {
    const user = userEvent.setup()
    const req = JSON.stringify({
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.com/a.png", detail: "high" },
            { type: "input_image", file_id: "file-abc" },
            { type: "input_file", filename: "report.pdf", file_id: "file-xyz", file_data: "data:application/pdf;base64,JVBERi0xLjQK" + "A".repeat(2048) },
          ],
        },
      ],
    })
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={req} responseBody={res} hasRequestBody />)
    await user.click(screen.getByRole("button", { name: /input/i }))
    // Expand the user-message row (its preview lists the part types).
    const rowBtn = Array.from(screen.getAllByRole("button")).find((b) =>
      (b.textContent ?? "").includes("input_image"),
    ) as HTMLButtonElement | undefined
    expect(rowBtn).not.toBeUndefined()
    await user.click(rowBtn!)
    // image url + file_id + the file part render.
    expect(await screen.findByText("https://example.com/a.png")).toBeInTheDocument()
    expect(screen.getByText(/file: file-abc/i)).toBeInTheDocument()
    expect(screen.getByText(/report\.pdf/i)).toBeInTheDocument()
    // file_data renders a byte-size label (KB or MB).
    expect(screen.getByText(/KB|MB/i)).toBeInTheDocument()
  })

  it("renders output_text annotations when present", async () => {
    const res = JSON.stringify({
      id: "r", object: "response", model: "gpt-4o", status: "completed",
      output: [
        {
          type: "message", role: "assistant",
          content: [{ type: "output_text", text: "cited answer", annotations: [{ type: "url_citation", url: "https://x" }] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    render(<OpenAiResponsesCallView requestBody={null} responseBody={res} hasRequestBody={false} />)
    // The assistant message renders inline (no input to expand).
    expect(await screen.findByText("cited answer")).toBeInTheDocument()
  })
})
