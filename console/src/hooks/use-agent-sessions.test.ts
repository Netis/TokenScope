import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { act, waitFor } from "@testing-library/react"
import {
  captureRequests,
  findRequest,
  jsonResponse,
  mockFetch,
  pinClock,
  qsOf,
  renderHookWithProviders,
  resetStore,
  setWindowOrigin,
} from "../../test/mocks"
import { PRESET_SECONDS, useToolbarStore } from "@/stores/toolbar"
import {
  useAgentSessionDetail,
  useAgentSessions,
  useSessionTurns,
} from "./use-agent-sessions"

const NOW_S = 1_780_000_000
let restoreClock: () => void

function setWindow(start: number, end: number) {
  resetStore(useToolbarStore, {
    preset: "custom",
    start,
    end,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
}

beforeAll(() => setWindowOrigin("http://localhost:8080/"))
beforeEach(() => {
  restoreClock = pinClock(NOW_S * 1000)
  setWindow(NOW_S - PRESET_SECONDS["1h"], NOW_S)
})
afterEach(() => restoreClock())

describe("useAgentSessions", () => {
  it("hits /api/agent-sessions with window + page_size + agent_kind (cursor omitted on first page)", async () => {
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(
      () => useAgentSessions({ agentKind: "claude-cli", pageSize: 25 }),
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, {
      start: String(NOW_S - PRESET_SECONDS["1h"]),
      end: String(NOW_S),
      page_size: "25",
      agent_kind: "claude-cli",
      cursor: null,
    }, "/api/agent-sessions"))
    expect(qs.get("page_size")).toBe("25")
    expect(qs.get("agent_kind")).toBe("claude-cli")
    expect(qs.has("cursor")).toBe(false)
  })

  it("omits agent_kind when empty (|| undefined → omitted)", async () => {
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(
      () => useAgentSessions({ agentKind: "" }),
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    findRequest(urls, { agent_kind: null }, "/api/agent-sessions")
  })

  it("defaults page_size to 50 when omitted", async () => {
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(() => useAgentSessions({}))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(qsOf(findRequest(urls, { page_size: "50" }, "/api/agent-sessions")).get("page_size")).toBe("50")
  })
})

describe("useAgentSessionDetail", () => {
  it("is disabled when sourceId/sessionId are null", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    renderHookWithProviders(() => useAgentSessionDetail(null, null))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
  })

  it("hits /api/agent-sessions/:source/:session with URL-encoded ids", async () => {
    const fake = { source_id: "s 1", session_id: "x y" }
    const urls = captureRequests(fake)
    const { result } = renderHookWithProviders(() => useAgentSessionDetail("s 1", "x y"))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, `/api/agent-sessions/${encodeURIComponent("s 1")}/${encodeURIComponent("x y")}`))
      .toBe(`/api/agent-sessions/${encodeURIComponent("s 1")}/${encodeURIComponent("x y")}`)
    expect(result.current.data).toEqual(fake)
  })
})

describe("useSessionTurns", () => {
  it("is disabled when sourceId/sessionId are null", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: { items: [], next_cursor: null } })
    })
    renderHookWithProviders(() => useSessionTurns(null, null))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
  })

  it("hits the turns endpoint with page_size (cursor omitted on first page)", async () => {
    const urls = captureRequests({ items: [], next_cursor: null })
    const { result } = renderHookWithProviders(() => useSessionTurns("s1", "ses1", 30))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const qs = qsOf(findRequest(urls, { page_size: "30", cursor: null }, "/api/agent-sessions/s1/ses1/turns"))
    expect(qs.get("page_size")).toBe("30")
    expect(qs.has("cursor")).toBe(false)
  })

  it("sends the cursor when provided via pageParam (next page)", async () => {
    const urls: string[] = []
    // First page (no cursor) → next_cursor "cur2"; second page (cursor=cur2)
    // → next_cursor null (last page) so hasNextPage flips to false.
    mockFetch((input) => {
      const u = String(input)
      urls.push(u)
      const qs = new URLSearchParams(u.split("?")[1] ?? "")
      const next_cursor = qs.get("cursor") === "cur2" ? null : "cur2"
      return jsonResponse({ code: 0, message: "ok", data: { items: [], next_cursor } })
    })
    const { result } = renderHookWithProviders(() => useSessionTurns("s1", "ses1"))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.hasNextPage).toBe(true)
    // Fetch the next page; pageParam becomes "cur2" → cursor=cur2.
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.hasNextPage).toBe(false))
    // The cursor=cur2 request was sent.
    findRequest(urls, { cursor: "cur2" }, "/api/agent-sessions/s1/ses1/turns")
  })
})
