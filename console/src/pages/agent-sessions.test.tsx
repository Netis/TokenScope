import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseSessionsPage, renderPage } from "../../test/fixtures"
import { AgentSessionsPage } from "./agent-sessions"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubSessions(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("AgentSessionsPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading state then populated session rows", async () => {
    stubSessions({
      "/api/filters/agent-kinds": { values: ["claude-cli"] },
      "/api/agent-sessions": baseSessionsPage(),
    })
    const { container, findByText } = renderPage(<AgentSessionsPage />, {
      initialEntries: ["/agent-sessions"],
    })
    // Loading spinner renders first.
    expect(container.querySelector("svg")).toBeInTheDocument()
    // Once data resolves, the session id + agent kind + preview render.
    expect(await findByText("sess-1")).toBeInTheDocument()
    expect(await findByText("Hello world")).toBeInTheDocument()
    // turns · calls · tokens summary line
    expect(await findByText(/5 turns/)).toBeInTheDocument()
  })

  it("renders the empty state when there are no sessions", async () => {
    stubSessions({
      "/api/filters/agent-kinds": { values: [] },
      "/api/agent-sessions": { items: [], next_cursor: null },
    })
    const { findByText } = renderPage(<AgentSessionsPage />, {
      initialEntries: ["/agent-sessions"],
    })
    expect(await findByText("No sessions found in the selected time range")).toBeInTheDocument()
  })

  it("renders the filter bar with the Agent kind dropdown", async () => {
    stubSessions({
      "/api/filters/agent-kinds": { values: ["claude-cli"] },
      "/api/agent-sessions": baseSessionsPage(),
    })
    const { findByText } = renderPage(<AgentSessionsPage />, {
      initialEntries: ["/agent-sessions"],
    })
    expect(await findByText("Agent kind")).toBeInTheDocument()
    expect(await findByText("Filters:")).toBeInTheDocument()
  })
})
