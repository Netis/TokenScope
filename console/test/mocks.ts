/**
 * Test helpers for the two state libraries the console uses — TanStack Query
 * (server state) and Zustand (client state). Kept here (under `console/test/`,
 * outside `src/`) so it never enters the production build typecheck or the
 * coverage denominator.
 *
 * Import the pieces you need from a `.test.tsx`:
 *
 *   import { renderWithQuery, mockFetch, resetStore } from "../../test/mocks"
 *
 * All helpers are test-isolation safe: `renderWithQuery` builds a fresh
 * `QueryClient` per call, and `resetStore`/`mockFetch` restore originals in an
 * `afterEach` they register themselves (Bun provides `afterEach`).
 */
import { afterEach, expect } from "bun:test"
import {
  QueryClient,
  QueryClientProvider,
  type QueryClientConfig,
} from "@tanstack/react-query"
import { render, renderHook, type RenderHookOptions, type RenderHookResult, type RenderOptions, type RenderResult } from "@testing-library/react"
import { MemoryRouter, type MemoryRouterProps } from "react-router"
import * as React from "react"
import type { ReactNode } from "react"
import type { UseBoundStore } from "zustand"

// ── TanStack Query ──────────────────────────────────────────────────────────

/**
 * A `QueryClient` tuned for tests: no retries, no background refetch, and
 * `gcTime: Infinity` so seeded cache data isn't evicted mid-test. Network
 * calls are suppressed by pairing this with `setQueryData` (preferred) or a
 * `mockFetch` stub, never by hitting a real API.
 */
export function createTestQueryClient(config?: QueryClientConfig): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        networkMode: "offlineFirst",
      },
      mutations: { retry: false, networkMode: "offlineFirst" },
    },
    ...config,
  })
}

interface RenderWithQueryOptions extends Omit<RenderOptions, "wrapper"> {
  /** Override the per-call QueryClient (defaults to a fresh `createTestQueryClient()`). */
  queryClient?: QueryClient
}

/**
 * `render` with a `QueryClientProvider` already wired, for components or
 * hooks that pull server state via `useQuery`/`useMutation`. Each call gets an
 * isolated client so cache state can't leak between tests.
 *
 *   const { getByText } = renderWithQuery(<ServicesPage />, {
 *     queryClient: createTestQueryClient(),
 *   })
 *
 * To exercise a `useQuery` hook without rendering a component, prefer
 * `renderHook` from `@testing-library/react` with this same client as the
 * wrapper — see the component-test docs for the worked example.
 */
export function renderWithQuery(
  ui: ReactNode,
  { queryClient = createTestQueryClient(), ...rest }: RenderWithQueryOptions = {},
): RenderResult {
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
  return render(ui, { wrapper, ...rest })
}

/**
 * Convenience wrapper around `client.setQueryData` so tests can seed cached
 * responses — the matching `useQuery` then returns the data without a fetch.
 * This is the recommended way to feed server state into a component test.
 *
 *   setQueryData(queryClient, ["services", {…}], fakeServices)
 */
export function setQueryData(
  client: QueryClient,
  queryKey: readonly unknown[],
  data: unknown,
): void {
  client.setQueryData(queryKey, data)
}

/**
 * `renderHook` already wired with a fresh `QueryClientProvider` (and, when
 * `router` is set, a `MemoryRouter`). The single shared helper for testing the
 * console's `useQuery`/`useInfiniteQuery`/`useMutation` hooks — the ones that
 * pull `start`/`end` off the toolbar store and server state via TanStack Query.
 *
 * Each call gets an isolated `QueryClient` (default) so cache state can't leak
 * between tests; pass `queryClient` to reuse one when you've seeded it with
 * `setQueryData`. Pass `initialEntries` for hooks that read `useLocation` /
 * `useSearchParams` (via `useSupportedFilterParams` or directly).
 *
 *   const { result } = renderHookWithProviders(() => useServices())
 *   const { result } = renderHookWithProviders(
 *     () => useLlmCalls({ page: 1, pageSize: 50, sortBy: "ts", sortOrder: "desc" }),
 *     { initialEntries: ["/llm-calls?wire_api=anthropic"] },
 *   )
 *
 * Returns the full `renderHook` result (`result.current`, `rerender`,
 * `unmount`); RTL's self-registered `afterEach` unmounts between tests.
 */
export function renderHookWithProviders<Result>(
  hook: () => Result,
  opts: {
    queryClient?: QueryClient
    /** MemoryRouter initial entries — enables useLocation/useSearchParams. */
    initialEntries?: MemoryRouterProps["initialEntries"]
  } = {},
): RenderHookResult<Result, unknown> {
  const queryClient = opts.queryClient ?? createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => {
    const inner = React.createElement(QueryClientProvider, { client: queryClient }, children)
    if (opts.initialEntries) {
      return React.createElement(MemoryRouter, { initialEntries: opts.initialEntries }, inner)
    }
    return inner
  }
  // renderHook expects a render fn taking initialProps; ours ignores them.
  return renderHook((() => hook()) as () => Result, { wrapper } as RenderHookOptions)
}

/** Await the microtask queue (for `queueMicrotask`-batched URL updates). */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => Promise.resolve().then(() => resolve()))
}


// ── fetch stubbing ───────────────────────────────────────────────────────────

type FetchImpl = typeof globalThis.fetch

/**
 * Install a `globalThis.fetch` stub for the duration of the test file. The
 * handler is called with each `Request | URL | string` and must return a
 * `Response` (use `Response.json(data, { status })` or the `jsonResponse`
 * helper below). The original `fetch` is restored automatically `afterEach`
 * and on any later re-install.
 *
 * Use this only when seeding `setQueryData` isn't enough — e.g. testing an
 * error path through `apiFetch`, or a component that calls `fetch` directly.
 *
 *   mockFetch((req) => jsonResponse({ code: 0, data: fakeServices }))
 */
export function mockFetch(handler: (req: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response): void {
  const original = globalThis.fetch
  restoreFns.push(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))) as FetchImpl
}

/**
 * Record every request URL the stubbed `fetch` receives into a fresh array,
 * responding with the given `data` (wrapped in the `{code,message,data}`
 * `ApiResponse` envelope `apiFetch` unwraps). Use this (over a single mutable
 * `cell`) when a hook may refetch under parallel-test contention — assert on
 * the request via `findRequest(urls, expected, endpoint)` so a stray refetch
 * from another query (often a different endpoint / params) can't clobber the
 * one you care about.
 *
 *   const urls = captureRequests({ services: [] })
 *   const req = qsOf(findRequest(urls, { start: "1000" }, "/api/services"))
 *   expect(req.get("end")).toBe("2000")
 *   expect(result.current.data).toEqual({ services: [] })
 *
 * The array is per-call; the underlying `mockFetch` self-restores afterEach.
 */
export function captureRequests(data: unknown = {}): string[] {
  const urls: string[] = []
  mockFetch((input) => {
    urls.push(String(input))
    return jsonResponse({ code: 0, message: "ok", data })
  })
  return urls
}

/** Parse the query string of a captured request URL into URLSearchParams. */
export function qsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "")
}

/**
 * Find a captured request whose path starts with `endpoint` (when given) and
 * whose query params match `expected`. For each key in `expected`:
 *   - `undefined` (or absent) → param is ignored (may be present or absent);
 *   - `null` → the param must be ABSENT (asserts "this filter is omitted");
 *   - a string → the param must be present with that value.
 *
 * Asserting on the returned request's `qsOf` (rather than a single mutable
 * `cell.url`) is robust to parallel-test contention: a stray refetch from
 * another query can't masquerade as this one unless it carries the exact same
 * endpoint + params, so a real "the hook sent the wrong params" bug still
 * fails.
 *
 *   const req = qsOf(findRequest(urls, { start: "1000", end: "2000", model: null }, "/api/services"))
 *   expect(req.get("wire_api")).toBe("anthropic")
 *
 * Throws (via expect) when no request matches, so failures name the missing
 * combination rather than silently passing.
 */
export function findRequest(
  urls: string[],
  expected: Record<string, string | null | undefined>,
  endpoint?: string,
): string {
  const match = urls.find((u) => {
    if (endpoint !== undefined && !u.startsWith(endpoint)) return false
    const qs = qsOf(u)
    return Object.entries(expected).every(([k, v]) => {
      if (v === undefined) return true
      if (v === null) return !qs.has(k)
      return qs.get(k) === v
    })
  })
  expect(
    match,
    `no captured request to ${endpoint ?? "(any)"} matched ${JSON.stringify(expected)} (got: ${JSON.stringify(urls)})`,
  ).toBeDefined()
  return match as string
}

/** Build a `Response` whose body is `JSON.stringify(body)` (default 200). */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

// ── Zustand ──────────────────────────────────────────────────────────────────

/**
 * Reset a Zustand store to a known state between tests. Zustand stores are
 * module singletons that survive across test files (and `persist`-backed ones
 * rehydrate from `localStorage`); call this in `afterEach` so a test that
 * mutated store state can't corrupt the next.
 *
 *   afterEach(() => resetStore(useSidebarStore, { expanded: false }))
 *
 * Pass the *full* desired state slice — `setState(..., false)` replaces rather
 * than merging, so any field you omit reverts to its `create()` default.
 */
export function resetStore<S extends object>(
  store: UseBoundStore<() => S>,
  initialState: Partial<S>,
): void {
  store.setState(initialState as Partial<S>, false)
}

// ── hook-test environment ────────────────────────────────────────────────────

/**
 * Pin `Date.now()` to a fixed value for the duration of a test, returning a
 * restore fn. Many console hooks derive their window (start/end) from
 * `Date.now()` at call time; a fixed clock makes param assertions exact.
 *
 *   const restore = pinClock(1_780_000_000 * 1000)
 *   afterEach(restore)
 */
export function pinClock(fixedMs: number): () => void {
  const orig = Date.now
  // @ts-expect-error — narrowing the global getter is intentional in tests
  Date.now = () => fixedMs
  return () => {
    Date.now = orig
  }
}

/**
 * Point the happy-dom window at a real origin. `apiFetch` builds request URLs
 * with `new URL(path, window.location.origin)`, but happy-dom loads the page
 * as `about:blank` → origin is the string `"null"` → `new URL(path, "null")`
 * throws. Call once in a hook test file's `beforeAll` so every fetch-bearing
 * hook resolves its URL. Each test file gets its own `Window` from the preload,
 * so this is file-scoped (it doesn't leak into other files' DOMs).
 *
 *   beforeAll(() => setWindowOrigin("http://localhost:8080/"))
 */
export function setWindowOrigin(href: string): void {
  window.location.href = href
}


// ── shared teardown ──────────────────────────────────────────────────────────

// Restore the process-level stubs installed by mockFetch. RTL's own
// afterEach (which it self-registers on import) handles unmounting rendered
// components, so only the fetch stubs need restoring here.
const restoreFns: Array<() => void> = []
afterEach(() => {
  while (restoreFns.length) restoreFns.pop()?.()
})
