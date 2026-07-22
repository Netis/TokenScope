import { describe, expect, it } from "bun:test"
import { act } from "@testing-library/react"
import { renderHookWithProviders } from "../../test/mocks"
import { useTurnUrlState } from "./use-turn-url-state"

// Renders the hook at an initial URL via a MemoryRouter. The hook's returned
// values reflect the parsed + updated search params, so we assert on those
// rather than reaching into the router's location.

describe("useTurnUrlState", () => {
  it("parses call + detail from the initial URL", () => {
    const { result } = renderHookWithProviders(() => useTurnUrlState(), {
      initialEntries: ["/x?call=7&detail=1"],
    })
    expect(result.current.call).toBe(7)
    expect(result.current.detail).toBe(true)
  })

  it("defaults call=null, detail=false when params are absent", () => {
    const { result } = renderHookWithProviders(() => useTurnUrlState(), {
      initialEntries: ["/x"],
    })
    expect(result.current.call).toBeNull()
    expect(result.current.detail).toBe(false)
  })

  it("setCall(n) writes ?call=n and leaves detail untouched", async () => {
    const { result } = renderHookWithProviders(() => useTurnUrlState(), {
      initialEntries: ["/x?call=1&detail=1"],
    })
    await act(async () => {
      result.current.setCall(42)
    })
    expect(result.current.call).toBe(42)
    // setCall(seq) only updates call; it clears detail only when seq is null.
    expect(result.current.detail).toBe(true)
  })

  it("setCall(null) clears call and detail", async () => {
    const { result } = renderHookWithProviders(() => useTurnUrlState(), {
      initialEntries: ["/x?call=1&detail=1"],
    })
    await act(async () => {
      result.current.setCall(null)
    })
    expect(result.current.call).toBeNull()
    expect(result.current.detail).toBe(false)
  })

  it("setDetail(true/false) toggles the detail flag without touching call", async () => {
    const { result } = renderHookWithProviders(() => useTurnUrlState(), {
      initialEntries: ["/x?call=5"],
    })
    await act(async () => {
      result.current.setDetail(true)
    })
    expect(result.current.detail).toBe(true)
    expect(result.current.call).toBe(5)
    await act(async () => {
      result.current.setDetail(false)
    })
    expect(result.current.detail).toBe(false)
    expect(result.current.call).toBe(5)
  })

  it("openDetail(seq) sets both call=seq and detail=1 in one update", async () => {
    const { result } = renderHookWithProviders(() => useTurnUrlState(), {
      initialEntries: ["/x"],
    })
    await act(async () => {
      result.current.openDetail(99)
    })
    expect(result.current.call).toBe(99)
    expect(result.current.detail).toBe(true)
  })

  it("detail is false when the param is anything other than '1'", () => {
    const { result } = renderHookWithProviders(() => useTurnUrlState(), {
      initialEntries: ["/x?detail=true"],
    })
    expect(result.current.detail).toBe(false)
  })
})
