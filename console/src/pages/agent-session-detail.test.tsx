import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { Route, Routes } from "react-router"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseSessionDetail, baseSessionTurnsPage, renderPage } from "../../test/fixtures"
import { AgentSessionDetailPage } from "./agent-session-detail"

beforeAll(() => {
  setWindowOrigin("http://localhost:8080/")
  // happy-dom lacks ResizeObserver, which the TurnBlock's ClampedMarkdown
  // uses in a useLayoutEffect. Install a no-op stub so the page renders.
  if (!globalThis.ResizeObserver) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  }
})

/** Stub fetch keyed by URL substring. Put longer/more-specific paths first
 * so the detail+turns routes match before the bare list route. */
function stubSessionDetail(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

/** renderPage wraps in MemoryRouter but defines no <Route>s, so useParams
 * returns {}. This wraps the page in a matching <Route> so useParams picks
 * up :source_id and :session_id from the initialEntries path. */
function renderSessionPage(initialEntry: string) {
  return renderPage(
    <Routes>
      <Route path="/agent-sessions/:source_id/:session_id" element={<AgentSessionDetailPage />} />
    </Routes>,
    { initialEntries: [initialEntry] },
  )
}

describe("AgentSessionDetailPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading spinner before the session resolves", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderSessionPage("/agent-sessions/src-1/sess-1")
    // lucide Loader2 renders an svg while loading.
    expect(container.querySelector("svg")).toBeInTheDocument()
    resolve(jsonResponse({ code: 0, message: "ok", data: baseSessionDetail() }))
  })

  it("renders the session header and turns once resolved", async () => {
    stubSessionDetail({
      // More-specific paths first so /api/agent-sessions/src-1/sess-1/turns
      // matches before /api/agent-sessions/src-1/sess-1.
      "/api/agent-sessions/src-1/sess-1/turns": baseSessionTurnsPage(),
      "/api/agent-sessions/src-1/sess-1": baseSessionDetail(),
    })
    const { findByText } = renderSessionPage("/agent-sessions/src-1/sess-1")
    // SessionHeader renders the session id + agent kind + summary.
    expect(await findByText("sess-1")).toBeInTheDocument()
    expect(await findByText(/5 turns/)).toBeInTheDocument()
    // TurnBlock renders the user input + assistant labels.
    expect(await findByText("Hello world")).toBeInTheDocument()
    expect(await findByText(/Assistant/)).toBeInTheDocument()
    // Back link.
    expect(await findByText("Agent Sessions")).toBeInTheDocument()
  })

  it("renders the 'Session not found' state when the detail endpoint fails", async () => {
    mockFetch(() => jsonResponse({ code: 5, message: "not found" }, { status: 500 }))
    const { findByText } = renderSessionPage("/agent-sessions/src-1/missing")
    expect(await findByText("Session not found")).toBeInTheDocument()
    expect(await findByText("Back to sessions")).toBeInTheDocument()
  })
})
