# Console component tests

The console tests on Bun's built-in test runner (`bun test`) — no Vitest, no
Jest, no separate test binary. Unit tests (pure functions, wire-API parsers)
live next to their source as `*.test.ts`. **Component tests** — anything that
renders React and asserts on the DOM — use the shared harness documented here.

## What the harness gives you

Every `bun test` run loads `test/setup.ts` as a preload (wired in
`bunfig.toml`'s `[test] preload`). It is the only setup component tests need;
you do **not** import it from individual test files. It provides:

- **happy-dom** as the global DOM. `document`, `window`, `HTMLElement`,
  `getComputedStyle`, `MutationObserver`, `requestAnimationFrame`, etc. all
  point at one happy-dom `Window`, so `react-dom/client`'s `createRoot` and
  React's `instanceof HTMLElement` checks resolve against the same DOM the
  components render into.
- **`@testing-library/jest-dom` matchers** (`toBeInTheDocument`,
  `toHaveTextContent`, `toBeVisible`, …) attached to Bun's global `expect`. They
  compose with Bun's built-in matchers — nothing is replaced.
- **`IS_REACT_ACT_ENVIRONMENT = true`** so React treats renders as wrapped in
  `act` (suppresses "not wrapped in act" noise).
- **Automatic cleanup** between tests — `@testing-library/react` registers a
  global `afterEach` on import (Bun provides `afterEach`), so each test starts
  with a clean DOM and a fresh render.

`test/mocks.ts` adds the two state libraries the console uses:

- **TanStack Query** — `createTestQueryClient`, `renderWithQuery`,
  `setQueryData` for rendering/querying components that pull server state via
  `useQuery`/`useMutation`.
- **Zustand** — `resetStore` to restore a store's singleton state between tests.
- **fetch stubbing** — `mockFetch` / `jsonResponse` for paths that go through
  `apiFetch` (use only when `setQueryData` is not enough, e.g. error paths).

## Where test files live

| Kind              | Location                                  | In coverage denominator? | In `tsc -b`? |
| ----------------- | ----------------------------------------- | ------------------------ | ------------ |
| Unit test         | `src/**/*.test.ts` (next to source)       | no (`.test.` excluded)   | no (excluded)|
| Component test    | `src/**/*.test.tsx` (next to component)   | no (`.test.` excluded)   | no (excluded)|
| Harness / helpers | `test/setup.ts`, `test/mocks.ts`          | no (outside `src/`)      | no           |

The coverage summarizer (`scripts/coverage/lib/summarize_coverage.py`) walks
`console/src/**` itself and excludes `.test.`/`.spec.` files, `__fixtures__`/
`fixtures`/`__mocks__` dirs, and `.d.ts`. The harness lives under `test/`
(outside `src/`) precisely so it never counts against the denominator —
keeping the denominator "full `src/`".

## The `@/*` import alias

Component tests (and the components they render) import via `@/lib/...`,
`@/stores/...`, etc. Bun resolves these at test time from the `paths` mapping
in the root `tsconfig.json` (`"@/*": ["./src/*"]`). Vite resolves the same
alias for the production build via `vite.config.ts`; the root tsconfig `paths`
mirror it for `bun test` so the two never drift. (Existing unit tests already
imported `@/types/api` — those were type-only and erased at runtime; value
imports like a component's `import { cn } from "@/lib/utils"` only resolve once
the root `paths` are in place.)

## Writing a component test

Import `render`/`screen` from `@testing-library/react`, `userEvent` from
`@testing-library/user-event`, and the component under test. Use the jest-dom
matchers against `expect`:

```tsx
// src/components/ui/collapsible-section.test.tsx
import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CollapsibleSection } from "./collapsible-section"

describe("CollapsibleSection", () => {
  it("starts collapsed and reveals its children on click", async () => {
    const user = userEvent.setup()
    render(
      <CollapsibleSection title="Headers">
        <p>hidden-until-open</p>
      </CollapsibleSection>,
    )
    // closed by default → children absent from the DOM
    expect(screen.queryByText("hidden-until-open")).not.toBeInTheDocument()
    // expand
    await user.click(screen.getByRole("button", { name: /headers/i }))
    expect(await screen.findByText("hidden-until-open")).toBeInTheDocument()
  })
})
```

Run it with `just test ts` (or `bun test` in `console/`), optionally filtered:
`bun test src/components/ui/collapsible-section.test.tsx`.

### With server state (TanStack Query)

Seed the cache with `setQueryData` and render through `renderWithQuery` — no
network, no `useQuery` fetch:

```tsx
import { describe, expect, it } from "bun:test"
import { renderHook } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import * as React from "react"
import { createTestQueryClient, setQueryData } from "../../test/mocks"
import { useServices } from "./use-services"
import { useToolbarStore } from "@/stores/toolbar"

const wrapper = (qc: ReturnType<typeof createTestQueryClient>) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children)

describe("useServices", () => {
  it("returns seeded data without a fetch", () => {
    const qc = createTestQueryClient()
    const { start, end } = useToolbarStore.getState()
    setQueryData(qc, ["services", { start, end, sortBy: "call_count", sortOrder: "desc", limit: 200 }], fakeServices)
    const { result } = renderHook(() => useServices(), { wrapper: wrapper(qc) })
    expect(result.current.data).toEqual(fakeServices)
  })
})
```

### With client state (Zustand)

Zustand stores are module singletons; reset them in `afterEach` so a test that
mutates store state can't corrupt the next:

```tsx
import { afterEach, describe, expect, it } from "bun:test"
import { resetStore } from "../../test/mocks"
import { useSidebarStore } from "@/stores/sidebar"

afterEach(() => resetStore(useSidebarStore, { expanded: false }))
```

### When you must stub `fetch`

For error paths or components that call `fetch` directly, `mockFetch` installs
a `globalThis.fetch` stub for the test file and restores it automatically
afterwards (it self-registers an `afterEach`):

```tsx
import { mockFetch, jsonResponse } from "../../test/mocks"

it("surfaces an API error", async () => {
  mockFetch(() => jsonResponse({ code: 5, message: "boom" }))
  // … render, assert the error state …
})
```

## Conventions

- Co-locate the test with the component (`foo.tsx` → `foo.test.tsx`), matching
  the existing `src/lib/*.test.ts` pattern.
- Prefer queries by role/label/text over test-ids (Testing Library guidance).
- Prefer `setQueryData` over `mockFetch` for happy-path server state.
- Keep the harness in `test/` — don't add setup logic to individual tests; put
  cross-cutting helpers in `test/mocks.ts` and let the preload handle the rest.
- See `test/setup.ts` for exactly which globals are registered if a component
  needs one that isn't (extend the preload there rather than per-test).
