import { beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import {
  captureRequests,
  findRequest,
  renderHookWithProviders,
  setWindowOrigin,
} from "../../test/mocks"
import { useRuntimeConfig } from "./use-runtime-config"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("useRuntimeConfig", () => {
  it("hits /api/runtime-config (no params) and returns the data", async () => {
    const fake = { loaded_at_ms: 1, config_path: "/x", version: "0.7", ebpf_available: false, config: {} }
    const urls = captureRequests(fake)
    const { result } = renderHookWithProviders(() => useRuntimeConfig())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(findRequest(urls, {}, "/api/runtime-config")).toBe("/api/runtime-config")
    expect(result.current.data).toEqual(fake)
  })
})
