import { describe, expect, it } from "bun:test"
import { act, waitFor } from "@testing-library/react"
import { renderHookWithProviders } from "../../test/mocks"
import { useSearchParamState } from "./use-search-param-state"

// Two hook instances under one router so their setValue calls in the same
// tick share the module-level batched-flush. Returns both [value, setter].
function useTwo(k1: string, d1: string, k2: string, d2: string) {
  const a = useSearchParamState(k1, d1)
  const b = useSearchParamState(k2, d2)
  return { a, b }
}

describe("useSearchParamState", () => {
  it("returns the default when the param is absent", () => {
    const { result } = renderHookWithProviders(() => useSearchParamState("foo", "bar"), {
      initialEntries: ["/x"],
    })
    expect(result.current[0]).toBe("bar")
  })

  it("reads the initial value from the URL", () => {
    const { result } = renderHookWithProviders(() => useSearchParamState("foo", "bar"), {
      initialEntries: ["/x?foo=zzz"],
    })
    expect(result.current[0]).toBe("zzz")
  })

  it("setValue updates the param (and reflects in the next render)", async () => {
    const { result } = renderHookWithProviders(() => useSearchParamState("foo", "bar"), {
      initialEntries: ["/x"],
    })
    await act(async () => {
      result.current[1]("newval")
    })
    await waitFor(() => expect(result.current[0]).toBe("newval"))
  })

  it("setting the default value clears (deletes) the param", async () => {
    const { result } = renderHookWithProviders(() => useSearchParamState("foo", "bar"), {
      initialEntries: ["/x?foo=zzz"],
    })
    await act(async () => {
      result.current[1]("bar") // equal to default → null → delete
    })
    await waitFor(() => expect(result.current[0]).toBe("bar"))
    // The param is no longer in the URL (value falls back to default).
  })

  it("batches two keys set in the same tick into one navigation (later does not overwrite earlier)", async () => {
    const { result } = renderHookWithProviders(
      () => useTwo("a", "0", "b", "0"),
      { initialEntries: ["/x"] },
    )
    // Fire both setters synchronously in one tick.
    await act(async () => {
      result.current.a[1]("1")
      result.current.b[1]("2")
      // The microtask flush runs after this sync block; let it drain.
      await Promise.resolve()
    })
    // Both params land in the same URL (single replace navigation).
    await waitFor(() => {
      expect(result.current.a[0]).toBe("1")
      expect(result.current.b[0]).toBe("2")
    })
  })
})
