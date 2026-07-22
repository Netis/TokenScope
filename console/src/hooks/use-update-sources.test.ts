import { beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import { renderHookWithProviders, setWindowOrigin } from "../../test/mocks"
import { useUpdateSources } from "./use-update-sources"
import type { CaptureSource } from "@/types/api"

// useUpdateSources calls fetch("/api/capture/sources", { method: "PUT", ... })
// directly (not via apiFetch), so each test stubs globalThis.fetch, inspects
// the request init, and restores it in a finally block. Mutations don't
// background-refetch, so the simple stub is deterministic here.
beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("useUpdateSources", () => {
  it("PUTs the sources to /api/capture/sources and returns restart_in_ms", async () => {
    const sources: CaptureSource[] = [
      { type: "pcap", interface: "eth0", bpf_filter: null, snaplen: 65535, source_id: null },
    ]
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    const orig = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedInit = init
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, message: "ok", data: { restart_in_ms: 5000 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as typeof fetch
    try {
      const { result } = renderHookWithProviders(() => useUpdateSources())
      result.current.mutate({ pipeline_name: "p1", sources })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(capturedUrl).toBe("/api/capture/sources")
      expect(capturedInit?.method).toBe("PUT")
      const headers = capturedInit?.headers as Record<string, string>
      expect(headers["content-type"]).toBe("application/json")
      const body = JSON.parse(String(capturedInit?.body))
      expect(body).toEqual({ pipeline_name: "p1", sources })
      expect(result.current.data).toEqual({ restart_in_ms: 5000 })
    } finally {
      globalThis.fetch = orig
    }
  })

  it("throws ApiError on a non-zero envelope code", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 7, message: "bad sources" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch
    try {
      const { result } = renderHookWithProviders(() => useUpdateSources())
      result.current.mutate({ pipeline_name: "p1", sources: [] })
      await waitFor(() => expect(result.current.isError).toBe(true))
      expect(result.current.error).toMatchObject({ name: "ApiError", code: 7, message: "bad sources" })
    } finally {
      globalThis.fetch = orig
    }
  })

  it("falls back to status/statusText when the error body isn't JSON", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(new Response("err", { status: 500, statusText: "ISE" }))) as typeof fetch
    try {
      const { result } = renderHookWithProviders(() => useUpdateSources())
      result.current.mutate({ pipeline_name: "p1", sources: [] })
      await waitFor(() => expect(result.current.isError).toBe(true))
      expect(result.current.error).toMatchObject({ name: "ApiError", code: 500, message: "ISE" })
    } finally {
      globalThis.fetch = orig
    }
  })
})
