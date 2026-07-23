import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"

import { TimelineBar } from "./timeline-bar"
import { baseLlmCallDetail, NOW_MS } from "../../../test/fixtures"

describe("TimelineBar", () => {
  it("renders the 'Timeline data unavailable' notice when complete_time is null", () => {
    render(
      <TimelineBar
        detail={baseLlmCallDetail({ complete_time: null, e2e_latency_ms: 1500 })}
      />,
    )
    expect(screen.getByText(/Timeline data unavailable/i)).toBeInTheDocument()
  })

  it("renders the notice when e2e_latency_ms is null", () => {
    render(
      <TimelineBar
        detail={baseLlmCallDetail({ complete_time: NOW_MS + 1500, e2e_latency_ms: null })}
      />,
    )
    expect(screen.getByText(/Timeline data unavailable/i)).toBeInTheDocument()
  })

  it("renders the timeline bars and the start/end timestamps", () => {
    const start = NOW_MS
    const end = NOW_MS + 1500
    render(
      <TimelineBar
        detail={baseLlmCallDetail({
          request_time: start,
          complete_time: end,
          ttft_ms: 300,
          e2e_latency_ms: 1500,
          is_stream: true,
        })}
      />,
    )
    // The formatDateTime strings appear at both ends.
    // The TTFT bar shows "TTFT 300.0ms" and the Gen bar shows "Gen 1.20s".
    expect(screen.getByText(/TTFT 300\.0ms/i)).toBeInTheDocument()
    expect(screen.getByText(/Gen 1\.20s/i)).toBeInTheDocument()
    // The bottom summary row also has TTFT and E2E.
    expect(screen.getByText(/TTFT: 300\.0ms/i)).toBeInTheDocument()
    expect(screen.getByText(/E2E: 1\.50s/i)).toBeInTheDocument()
  })

  it("uses 'TTFB' labels for non-streaming calls", () => {
    render(
      <TimelineBar
        detail={baseLlmCallDetail({
          request_time: NOW_MS,
          complete_time: NOW_MS + 1000,
          ttft_ms: 500,
          e2e_latency_ms: 1000,
          is_stream: false,
        })}
      />,
    )
    expect(screen.getByText(/TTFB 500\.0ms/i)).toBeInTheDocument()
    expect(screen.getByText(/TTFB: 500\.0ms/i)).toBeInTheDocument()
  })

  it("renders an em dash when ttft_ms is null", () => {
    render(
      <TimelineBar
        detail={baseLlmCallDetail({
          request_time: NOW_MS,
          complete_time: NOW_MS + 1000,
          ttft_ms: null,
          e2e_latency_ms: 1000,
          is_stream: true,
        })}
      />,
    )
    // The bottom summary line shows "TTFT: —" (with the em dash value).
    expect(screen.getByText(/TTFT:/i)?.textContent ?? "").toContain("—")
  })

  it("renders only the Gen bar when ttft_ms is 0", () => {
    const { container } = render(
      <TimelineBar
        detail={baseLlmCallDetail({
          request_time: NOW_MS,
          complete_time: NOW_MS + 1000,
          ttft_ms: 0,
          e2e_latency_ms: 1000,
          is_stream: true,
        })}
      />,
    )
    // ttftRatio = 0 → no TTFT bar. Only Gen bar is rendered (with the bg-blue-400/80 class).
    expect(container.querySelector(".bg-amber-400\\/80")).toBeNull()
    expect(container.querySelector(".bg-blue-400\\/80")).not.toBeNull()
  })
})
