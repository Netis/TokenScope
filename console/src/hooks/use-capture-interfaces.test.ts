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
import { useCaptureInterfaces } from "./use-capture-interfaces"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("useCaptureInterfaces", () => {
  it("hits /api/capture/interfaces (no params) and returns the data", async () => {
    const fake = { interfaces: [] }
    const urls = captureRequests(fake)
    const { result } = renderHookWithProviders(() => useCaptureInterfaces())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/capture/interfaces")).toBe("/api/capture/interfaces")
    expect(result.current.data).toEqual(fake)
  })

  it("does not auto-refetch on mount (staleTime Infinity)", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: { interfaces: [] } })
    })
    const { result } = renderHookWithProviders(() => useCaptureInterfaces())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(calls).toBe(1) // a single fetch, no background refetch
  })
})
