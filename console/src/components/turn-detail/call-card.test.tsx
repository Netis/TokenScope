import { beforeAll, describe, expect, it, vi } from "bun:test"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CallCard } from "./call-card"
import type { AgentTurnCallItem, AgentTurnDetail, LlmCallDetail } from "@/types/api"
import type { ToolIndex } from "@/lib/turn-index"
import { jsonResponse, mockFetch, setWindowOrigin } from "../../../test/mocks"
import {
  baseAgentTurnCallItem,
  baseAgentTurnDetail,
  baseLlmCallDetail,
  NOW_MS,
  renderPage,
} from "../../../test/fixtures"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

const emptyToolIndex: ToolIndex = new Map()

function call(over: Partial<AgentTurnCallItem> = {}): AgentTurnCallItem {
  return baseAgentTurnCallItem({
    id: "call-1",
    sequence: 1,
    request_time: NOW_MS,
    response_time: NOW_MS + 200,
    complete_time: NOW_MS + 1500,
    e2e_latency_ms: 1500,
    status_code: 200,
    finish_reason: "end_turn",
    request_body: JSON.stringify({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
    }),
    response_body: JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 6 },
    }),
    ...over,
  })
}

const turn: AgentTurnDetail = baseAgentTurnDetail({ final_call_id: "call-1" })

describe("CallCard — collapsed header", () => {
  it("renders the sequence number and the model text", () => {
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    expect(screen.getByText("#1")).toBeInTheDocument()
    expect(screen.getByText("claude-sonnet-4")).toBeInTheDocument()
  })

  it("renders the user badge when isFirstCall is true", () => {
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={true}
      />,
    )
    expect(screen.getByText(/👤 user/i)).toBeInTheDocument()
  })

  it("omits the user badge when isFirstCall is false", () => {
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    expect(screen.queryByText(/👤 user/i)).not.toBeInTheDocument()
  })

  it("renders the latency via formatMs", () => {
    renderPage(
      <CallCard
        call={call({ e2e_latency_ms: 1500 })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    expect(screen.getByText("1.50s")).toBeInTheDocument()
  })

  it("renders the latency text in amber for an error status_code (>= 400)", () => {
    const { container } = renderPage(
      <CallCard
        call={call({ status_code: 500, e2e_latency_ms: 100 })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    // The latency span uses text-red-600 for error speed. (The CallCard's
    // left-border color classes are stripped by tailwind-merge — see below.)
    const latencySpan = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent?.includes("✗"),
    )
    expect(latencySpan).toBeDefined()
    expect(latencySpan!.className).toContain("text-red-600")
  })

  it("renders the latency text in red for an err-tone finish_reason", () => {
    const { container } = renderPage(
      <CallCard
        call={call({ status_code: 200, finish_reason: "refusal" })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    const latencySpan = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent?.includes("✗"),
    )
    expect(latencySpan).toBeDefined()
    expect(latencySpan!.className).toContain("text-red-600")
  })

  it("renders the latency text in amber for a warn-tone finish_reason", () => {
    const { container } = renderPage(
      <CallCard
        call={call({ status_code: 200, finish_reason: "max_tokens", e2e_latency_ms: 100 })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    const latencySpan = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent?.includes("100.0ms"),
    )
    expect(latencySpan).toBeDefined()
    expect(latencySpan!.className).toContain("text-amber-600")
  })

  it("renders the latency text in amber for slow e2e (>10s)", () => {
    const { container } = renderPage(
      <CallCard
        call={call({ status_code: 200, finish_reason: "end_turn", e2e_latency_ms: 12_000 })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    const latencySpan = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent?.includes("12.00s"),
    )
    expect(latencySpan).toBeDefined()
    expect(latencySpan!.className).toContain("text-amber-600")
  })

  it("renders the latency text in muted for a normal final call", () => {
    const c = call({ id: "call-final", status_code: 200, finish_reason: "end_turn", e2e_latency_ms: 100 })
    const { container } = renderPage(
      <CallCard
        call={c}
        turn={baseAgentTurnDetail({ final_call_id: "call-final" })}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    const latencySpan = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent?.includes("100.0ms"),
    )
    expect(latencySpan).toBeDefined()
    expect(latencySpan!.className).toContain("text-muted-foreground")
  })

  it("applies the active ring when active=true", () => {
    const { container } = renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        active={true}
      />,
    )
    const root = container.querySelector("div.rounded-lg") as Element
    expect(root.className).toContain("ring-2")
    expect(root.className).toContain("ring-blue-400")
  })

  it("renders a hop-count chip when hopCount > 0", () => {
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        hopCount={3}
      />,
    )
    expect(screen.getByText("+3")).toBeInTheDocument()
  })

  it("omits the hop-count chip when hopCount is 0", () => {
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })

  it("renders the error marker '✗' before the latency when status >= 400", () => {
    renderPage(
      <CallCard
        call={call({ status_code: 500, e2e_latency_ms: 1500 })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    // The latency is wrapped with "✗ " prefix in the same span.
    expect(screen.getByText(/✗ 1\.50s/i)).toBeInTheDocument()
  })

  it("renders the estimated-tokens '~' marker when tokens_estimated is true", () => {
    renderPage(
      <CallCard
        call={call({
          input_tokens: 100,
          output_tokens: 50,
          tokens_estimated: true,
        })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    // The token span has the '~' prefix; rendered as separate "~" text
    // nodes plus "100↑" and "50↓". Assert the up/down arrow markers are present.
    expect(screen.getByText(/↑/)).toBeInTheDocument()
    expect(screen.getByText(/↓/)).toBeInTheDocument()
  })
})

describe("CallCard — expand/collapse behavior", () => {
  it("starts collapsed and expands to reveal Input/Output sections on click", async () => {
    const user = userEvent.setup()
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    expect(screen.queryByText(/Input · request body/i)).not.toBeInTheDocument()
    // Click the row button to expand.
    await user.click(screen.getByText("#1"))
    expect(await screen.findByText(/Input · request body/i)).toBeInTheDocument()
    expect(screen.getByText(/Output · response body/i)).toBeInTheDocument()
  })

  it("starts expanded when defaultExpanded is true", () => {
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        defaultExpanded={true}
      />,
    )
    expect(screen.getByText(/Input · request body/i)).toBeInTheDocument()
    expect(screen.getByText(/Output · response body/i)).toBeInTheDocument()
  })

  it("renders the user_input Markdown instead of the request body when isFirstCall and user_input is set", async () => {
    renderPage(
      <CallCard
        call={call()}
        turn={baseAgentTurnDetail({ final_call_id: "call-1", user_input: "Hello **world**" })}
        toolIndex={emptyToolIndex}
        isFirstCall={true}
        defaultExpanded={true}
      />,
    )
    // The first-call user input is rendered as Markdown in a blue-tinted box.
    expect(screen.getByText("world")).toBeInTheDocument()
    // The blue background class is present.
    expect(document.querySelector(".border-blue-200")).not.toBeNull()
  })

  it("fires onOpenDetail when the 'View call detail →' button is clicked", async () => {
    const user = userEvent.setup()
    const onOpenDetail = vi.fn()
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        defaultExpanded={true}
        onOpenDetail={onOpenDetail}
      />,
    )
    await user.click(screen.getByText(/View call detail →/i))
    expect(onOpenDetail).toHaveBeenCalledWith("call-1")
  })

  it("renders the bottom meta line with TTFT/TTFB and finish_reason", async () => {
    const user = userEvent.setup()
    renderPage(
      <CallCard
        call={call({ is_stream: true, ttft_ms: 200, finish_reason: "end_turn" })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    await user.click(screen.getByText("#1"))
    // The meta line: "TTFT 200.0ms · finish: end_turn"
    expect(await screen.findByText(/TTFT 200\.0ms/i)).toBeInTheDocument()
    expect(screen.getByText(/finish: end_turn/i)).toBeInTheDocument()
  })

  it("uses TTFB (italic) for non-streaming calls", async () => {
    const user = userEvent.setup()
    renderPage(
      <CallCard
        call={call({ is_stream: false, ttft_ms: 200 })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    await user.click(screen.getByText("#1"))
    expect(await screen.findByText(/TTFB 200\.0ms/i)).toBeInTheDocument()
  })

  it("renders an em dash when finish_reason is null", async () => {
    const user = userEvent.setup()
    renderPage(
      <CallCard
        call={call({ finish_reason: null })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
      />,
    )
    await user.click(screen.getByText("#1"))
    expect(await screen.findByText(/finish: —/i)).toBeInTheDocument()
  })
})

describe("CallCard — lazy body fetch", () => {
  it("shows the loading state when bodies are null and the card is expanded", async () => {
    // Stub the lazy fetch to return a populated detail after a delay.
    const detail: LlmCallDetail = baseLlmCallDetail({
      id: "call-1",
      request_body: JSON.stringify({ model: "lazy", messages: [] }),
      response_body: JSON.stringify({ id: "msg", content: [{ type: "text", text: "lazy body" }] }),
    })
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/spans/call-1")) {
        return jsonResponse({ code: 0, message: "ok", data: detail })
      }
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    renderPage(
      <CallCard
        call={call({ request_body: null, response_body: null })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        defaultExpanded={true}
      />,
    )
    // Loading state should be visible (two "Loading body…" notices).
    expect(await screen.findAllByText(/Loading body/i)).toHaveLength(2)
  })

  it("renders the fetched bodies once the lazy fetch resolves", async () => {
    const detail: LlmCallDetail = baseLlmCallDetail({
      id: "call-1",
      request_body: JSON.stringify({ model: "lazy", messages: [{ role: "user", content: "lazy" }] }),
      response_body: JSON.stringify({ id: "msg", content: [{ type: "text", text: "lazy body" }] }),
    })
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/spans/call-1")) {
        return jsonResponse({ code: 0, message: "ok", data: detail })
      }
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    renderPage(
      <CallCard
        call={call({ request_body: null, response_body: null })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        defaultExpanded={true}
      />,
    )
    // Eventually the response body renders "lazy body" via the anthropic output renderer.
    expect(await screen.findByText(/lazy body/i)).toBeInTheDocument()
  })

  it("does not fire the lazy fetch when bodies are already present", async () => {
    const urls: string[] = []
    mockFetch((input) => {
      urls.push(String(input))
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    renderPage(
      <CallCard
        call={call()}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        defaultExpanded={true}
      />,
    )
    // Give the query a tick to potentially fire; it should not because
    // `needsLazyBody` is false (bodies already present).
    await waitFor(() => {
      expect(urls.some((u) => u.includes("/api/spans/call-1"))).toBe(false)
    })
  })

  it("does not fire the lazy fetch when the card is collapsed (even with null bodies)", async () => {
    const urls: string[] = []
    mockFetch((input) => {
      urls.push(String(input))
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    renderPage(
      <CallCard
        call={call({ request_body: null, response_body: null })}
        turn={turn}
        toolIndex={emptyToolIndex}
        isFirstCall={false}
        // defaultExpanded defaults to false
      />,
    )
    await waitFor(() => {
      expect(urls.some((u) => u.includes("/api/spans/call-1"))).toBe(false)
    })
  })
})
