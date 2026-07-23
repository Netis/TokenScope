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
import { useLlmCallDetail } from "./use-llm-call-detail"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("useLlmCallDetail", () => {
  it("is disabled (no fetch) when id is null", async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return jsonResponse({ code: 0, message: "ok", data: {} })
    })
    const { result } = renderHookWithProviders(() => useLlmCallDetail(null))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
    expect(result.current.fetchStatus).toBe("idle")
  })

  it("hits /api/spans/:id with URL-encoded id when id is set", async () => {
    const id = "s 1"
    const fake = { id }
    const urls = captureRequests(fake)
    const { result } = renderHookWithProviders(() => useLlmCallDetail(id))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, `/api/spans/${encodeURIComponent(id)}`))
      .toBe(`/api/spans/${encodeURIComponent(id)}`)
    expect(result.current.data).toEqual(fake)
  })
})
