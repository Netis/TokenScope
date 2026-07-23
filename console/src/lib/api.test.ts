import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { ApiError, apiFetch, downloadFile } from "./api"
import { jsonResponse, mockFetch } from "../../test/mocks"

// apiFetch reads window.location.origin to build its URL. happy-dom loads
// the page as about:blank → origin === "null" → new URL(path, null) throws.
// Point the happy-dom window at a real origin for this file (each test file
// gets its own Window from the preload, so this is file-scoped).
beforeAll(() => {
  window.location.href = "http://localhost:8080/"
})

// Restore the process-level stubs mockFetch / createElementMock install.
const restoreFns: Array<() => void> = []
afterEach(() => {
  while (restoreFns.length) restoreFns.pop()?.()
})

describe("ApiError", () => {
  it("carries the code + message and the ApiError name", () => {
    const e = new ApiError(5, "boom")
    expect(e.code).toBe(5)
    expect(e.message).toBe("boom")
    expect(e.name).toBe("ApiError")
    expect(e instanceof Error).toBe(true)
  })
})

describe("apiFetch", () => {
  it("unwraps ApiResponse.data on success and calls the right path", async () => {
    let capturedPath = ""
    mockFetch((input) => {
      capturedPath = String(input)
      return jsonResponse({ code: 0, message: "ok", data: { hello: "world" } })
    })
    const data = await apiFetch<{ hello: string }>("/api/services")
    expect(data).toEqual({ hello: "world" })
    expect(capturedPath).toBe("/api/services")
  })

  it("serializes params into the query string, omitting undefined and empty", async () => {
    let capturedPath = ""
    mockFetch((input) => {
      capturedPath = String(input)
      return jsonResponse({ code: 0, message: "ok", data: 1 })
    })
    await apiFetch("/api/services", {
      start: 1000,
      end: 2000,
      wire_api: "anthropic",
      empty: "",
      skipped: undefined,
      num: 42,
      bool: true,
    })
    const qs = new URLSearchParams(capturedPath.split("?")[1] ?? "")
    expect(qs.get("start")).toBe("1000")
    expect(qs.get("end")).toBe("2000")
    expect(qs.get("wire_api")).toBe("anthropic")
    expect(qs.get("num")).toBe("42")
    expect(qs.get("bool")).toBe("true")
    expect(qs.has("empty")).toBe(false)
    expect(qs.has("skipped")).toBe(false)
  })

  it("makes no query string when no params are given", async () => {
    let capturedPath = ""
    mockFetch((input) => {
      capturedPath = String(input)
      return jsonResponse({ code: 0, message: "ok", data: null })
    })
    await apiFetch("/api/health")
    expect(capturedPath).toBe("/api/health")
  })

  it("throws ApiError with the envelope code/message on a non-zero envelope code", async () => {
    mockFetch(() => jsonResponse({ code: 7, message: "validation failed", data: null }))
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      name: "ApiError",
      code: 7,
      message: "validation failed",
    })
  })

  it("throws ApiError on a non-ok HTTP status, parsing the error body when JSON", async () => {
    mockFetch(() =>
      jsonResponse({ code: 404, message: "not found" }, { status: 404 }),
    )
    await expect(apiFetch("/api/missing")).rejects.toMatchObject({
      name: "ApiError",
      code: 404,
      message: "not found",
    })
  })

  it("falls back to res.status / res.statusText when the error body is not JSON", async () => {
    mockFetch(() =>
      new Response("plain text error", { status: 503, statusText: "Service Unavailable" }),
    )
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      name: "ApiError",
      code: 503,
      message: "Service Unavailable",
    })
  })

  it("falls back to res.status when envelope has no code field", async () => {
    // A 500 with a JSON body that lacks code → body.code ?? res.status.
    mockFetch(() =>
      jsonResponse({ unexpected: "shape" }, { status: 500, statusText: "ISE" }),
    )
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      name: "ApiError",
      code: 500,
      message: "ISE",
    })
  })
})

describe("downloadFile", () => {
  // Capture the anchor downloadFile builds + clicks so we can assert the
  // derived filename reached it, without relying on a real browser click.
  // Replaces document.createElement for the file's lifetime and no-ops the
  // anchor's click. URL.createObjectURL / revokeObjectURL are left as the
  // happy-dom originals (they work and produce real blob: URLs), so we only
  // intercept anchor construction.
  function captureAnchor(): { anchor: HTMLAnchorElement | null } {
    const state: { anchor: HTMLAnchorElement | null } = { anchor: null }
    const origCreate = document.createElement.bind(document)
    document.createElement = ((tag: string) => {
      const el = origCreate(tag)
      if (tag.toLowerCase() === "a") {
        state.anchor = el as HTMLAnchorElement
        // happy-dom anchor.click() is a no-op for navigation; override to
        // avoid any navigation attempts and keep it deterministic.
        ;(el as unknown as { click: () => void }).click = () => {}
      }
      return el
    }) as typeof document.createElement

    restoreFns.push(() => {
      document.createElement = origCreate
    })
    return state
  }

  it("parses the filename out of the content-disposition header and clicks an anchor", async () => {
    const cap = captureAnchor()
    mockFetch(() =>
      new Response("ndjson-line\n", {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="turns-abc.ndjson"',
          "x-export-skipped": "2",
          "x-export-total": "10",
          "x-export-written": "8",
        },
      }),
    )
    const result = await downloadFile("/api/export/trajectory", "fallback.ndjson")
    expect(result).toEqual({ skipped: 2, total: 10, written: 8 })
    expect(cap.anchor).not.toBeNull()
    // downloadFile assigns the blob: object URL the browser produced.
    expect(cap.anchor?.href.startsWith("blob:")).toBe(true)
    expect(cap.anchor?.download).toBe("turns-abc.ndjson")
  })

  it("falls back to the provided name when content-disposition is absent", async () => {
    const cap = captureAnchor()
    mockFetch(() => new Response("x", { status: 200 }))
    await downloadFile("/api/export/trajectory", "fallback.ndjson")
    expect(cap.anchor?.download).toBe("fallback.ndjson")
  })

  it("parses an unquoted filename in content-disposition", async () => {
    const cap = captureAnchor()
    mockFetch(() =>
      new Response("x", {
        status: 200,
        headers: { "content-disposition": "attachment; filename=sessions.jsonl" },
      }),
    )
    await downloadFile("/p", "fallback")
    expect(cap.anchor?.download).toBe("sessions.jsonl")
  })

  it("defaults the X-Export-* counters to 0 when the headers are missing", async () => {
    mockFetch(() => new Response("x", { status: 200 }))
    const result = await downloadFile("/p", "f")
    expect(result).toEqual({ skipped: 0, total: 0, written: 0 })
  })

  it("throws ApiError on a non-ok HTTP status", async () => {
    mockFetch(() => jsonResponse({ code: 5, message: "nope" }, { status: 500 }))
    await expect(downloadFile("/p", "f")).rejects.toMatchObject({
      name: "ApiError",
      code: 5,
      message: "nope",
    })
  })

  it("uses status fallback when the error body is not JSON", async () => {
    mockFetch(() => new Response("err", { status: 418, statusText: "I'm a teapot" }))
    await expect(downloadFile("/p", "f")).rejects.toMatchObject({
      name: "ApiError",
      code: 418,
      message: "I'm a teapot",
    })
  })
})
