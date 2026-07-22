import { beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import {
  captureRequests,
  findRequest,
  jsonResponse,
  mockFetch,
  renderHookWithProviders,
  setWindowOrigin,
} from "../../test/mocks"
import { useHttpExchange } from "./use-http-exchange"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("useHttpExchange", () => {
  it("is disabled (no fetch) when id is null", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { result } = renderHookWithProviders(() => useHttpExchange(null))
    // Give any pending fetch a chance to run (it shouldn't).
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
    expect(result.current.fetchStatus).toBe("idle")
    expect(result.current.data).toBeUndefined()
  })

  it("hits /api/http-exchanges/:id with URL-encoded id when id is set", async () => {
    const id = "a b" // space — a realistic opaque id that must be encoded
    const fake = { id }
    const urls = captureRequests(fake)
    const { result } = renderHookWithProviders(() => useHttpExchange(id))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, `/api/http-exchanges/${encodeURIComponent(id)}`))
      .toBe(`/api/http-exchanges/${encodeURIComponent(id)}`)
    expect(result.current.data).toEqual(fake)
  })
})
