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
import { afterEach } from "bun:test"
import {
  QueryClient,
  QueryClientProvider,
  type QueryClientConfig,
} from "@tanstack/react-query"
import { render, type RenderOptions, type RenderResult } from "@testing-library/react"
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

// ── shared teardown ──────────────────────────────────────────────────────────

// Restore the process-level stubs installed by mockFetch. RTL's own
// afterEach (which it self-registers on import) handles unmounting rendered
// components, so only the fetch stubs need restoring here.
const restoreFns: Array<() => void> = []
afterEach(() => {
  while (restoreFns.length) restoreFns.pop()?.()
})
