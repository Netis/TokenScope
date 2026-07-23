/**
 * Component-test harness preload — registered for every `bun test` via
 * `bunfig.toml` `[test] preload`. It is the single shared setup that turns
 * the bare Bun runtime into a DOM-capable, Testing-Library-ready
 * environment for React component tests.
 *
 * The console ships no Vitest / Jest environment; Bun's own test runner is
 * the runner, and happy-dom supplies the DOM. This file wires them together
 * once per test file (preloads run before each test file):
 *
 *   1. Instantiate a happy-dom `Window` and hoist its DOM globals onto
 *      `globalThis` so `react-dom/client`'s `createRoot` and React's
 *      `instanceof HTMLElement` checks resolve against the same DOM
 *      implementation the components render into.
 *   2. Attach `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
 *      `toHaveTextContent`, …) to Bun's global `expect`.
 *   3. Set `IS_REACT_ACT_ENVIRONMENT = true` so React treats test renders
 *      as wrapped in `act` (suppresses the "not wrapped in act" warning).
 *
 * Ordering matters: `@testing-library/dom`'s `screen` captures `document`
 * at module-eval time (`const screen = typeof document !== 'undefined' &&
 * document.body ? … : throwingStub`), so the DOM globals MUST exist on
 * `globalThis` before anything pulls `@testing-library/dom` in. We set the
 * globals up front and only `await import()` jest-dom afterwards (a static
 * `import` would hoist above the assignment and defeat the ordering).
 *
 * Auto-cleanup of rendered components between tests is handled by
 * `@testing-library/react` itself — it registers a global `afterEach` hook
 * on import when one exists (Bun provides `afterEach`). See `mocks.ts` for
 * query/store test helpers and `test/TESTING.md` for the walkthrough.
 *
 * Lives under `console/test/` (not `src/`) so it is neither typechecked by
 * the production `tsc -b` (which includes only `src`) nor counted in the
 * coverage denominator (the summarizer walks `src/**`).
 */
import { Window } from "happy-dom"

// ── 1. happy-dom globals — set BEFORE any @testing-library import ───────────
// Hoist the DOM surface from one happy-dom Window onto globalThis. React DOM
// and Testing Library read `document`, `window`, `HTMLElement`,
// `getComputedStyle`, etc. off the global scope; pointing all of them at the
// *same* Window instance keeps `instanceof`/prototype checks consistent.
const win = new Window()

const g = globalThis as unknown as Record<string, unknown>
g.window = win
g.document = win.document
g.navigator = win.navigator
g.getComputedStyle = win.getComputedStyle.bind(win)
g.HTMLElement = win.HTMLElement
g.Element = win.Element
g.Node = win.Node
g.MutationObserver = win.MutationObserver
g.requestAnimationFrame = win.requestAnimationFrame.bind(win)
g.cancelAnimationFrame = win.cancelAnimationFrame.bind(win)

// react-dom/client reads this to decide whether state updates are under `act`.
g.IS_REACT_ACT_ENVIRONMENT = true

// ── 2. jest-dom matchers — imported AFTER the globals exist ─────────────────
// Top-level await (supported in Bun ESM) guarantees `screen` is built against
// the live `document` rather than its throwing stub.
await import("@testing-library/jest-dom")

// ── 3. generous async wait timeout ──────────────────────────────────────────
// `bun test` runs many files concurrently (one process per worker). Under
// heavy parallel CPU contention a react-query fetch + React re-render can
// take longer than RTL's 1000ms `waitFor` default to settle, producing flaky
// timeouts that aren't real failures. Bump the shared async-utility timeout
// so hook/component tests stay green regardless of worker load.
const { configure } = await import("@testing-library/react")
configure({ asyncUtilTimeout: 5000 })

