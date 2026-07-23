import { describe, expect, it } from "bun:test"
import {
  defaultsFor,
  validate,
  buildExtractUrl,
  type ExtractFormValues,
} from "./extract-defaults"
import {
  baseLlmCallDetail,
  baseHttpExchangeDetail,
  baseAgentTurnDetail,
} from "../../../test/fixtures"

const SECOND_US = 1_000_000

describe("defaultsFor", () => {
  it("builds initial values from an http_exchange anchor with response_complete_time", () => {
    const row = baseHttpExchangeDetail({
      source_id: "src-1",
      client_ip: "10.0.0.9",
      client_port: 54000,
      server_ip: "10.0.0.1",
      server_port: 8080,
      request_time: 1_000_000,
      response_complete_time: 1_000_000 + 5_000,
    })
    const v = defaultsFor({ type: "http_exchange", row })
    expect(v.source_id).toBe("src-1")
    expect(v.client_ip).toBe("10.0.0.9")
    expect(v.client_port).toBe("54000")
    expect(v.server_ip).toBe("10.0.0.1")
    expect(v.server_port).toBe("8080")
    // start_us = request_time * 1000 - 1s
    expect(v.start_us).toBe(1_000_000 * 1000 - SECOND_US)
    // end_us = response_complete_time * 1000 + 1s
    expect(v.end_us).toBe((1_000_000 + 5_000) * 1000 + SECOND_US)
  })

  it("falls back to request_time + 5s when http_exchange has no response_complete_time", () => {
    const row = baseHttpExchangeDetail({
      request_time: 1_000_000,
      response_complete_time: undefined as unknown as number,
    })
    const v = defaultsFor({ type: "http_exchange", row })
    // end_us = request_time * 1000 + 5s
    expect(v.end_us).toBe(1_000_000 * 1000 + 5 * SECOND_US)
  })

  it("handles missing client_port / server_port on http_exchange (string fallback)", () => {
    const row = baseHttpExchangeDetail({
      client_port: undefined as unknown as number,
      server_port: undefined as unknown as number,
    })
    const v = defaultsFor({ type: "http_exchange", row })
    expect(v.client_port).toBe("")
    expect(v.server_port).toBe("")
  })

  it("handles missing source_id on http_exchange (empty string)", () => {
    const row = baseHttpExchangeDetail({ source_id: null as unknown as string })
    const v = defaultsFor({ type: "http_exchange", row })
    expect(v.source_id).toBe("")
  })

  it("builds initial values from an llm_call anchor with complete_time", () => {
    const row = baseLlmCallDetail({
      source_id: "src-2",
      client_ip: "10.0.0.10",
      client_port: 55000,
      server_ip: "10.0.0.2",
      server_port: 9000,
      request_time: 2_000_000,
      complete_time: 2_000_000 + 3000,
    })
    const v = defaultsFor({ type: "llm_call", row })
    expect(v.source_id).toBe("src-2")
    expect(v.client_ip).toBe("10.0.0.10")
    expect(v.client_port).toBe("55000")
    expect(v.server_ip).toBe("10.0.0.2")
    expect(v.server_port).toBe("9000")
    expect(v.start_us).toBe(2_000_000 * 1000 - SECOND_US)
    expect(v.end_us).toBe((2_000_000 + 3000) * 1000 + SECOND_US)
  })

  it("falls back to response_time when llm_call has no complete_time", () => {
    const row = baseLlmCallDetail({
      request_time: 3_000_000,
      complete_time: undefined as unknown as number,
      response_time: 3_000_000 + 500,
    })
    const v = defaultsFor({ type: "llm_call", row })
    // end_us = response_time * 1000 + 1s
    expect(v.end_us).toBe((3_000_000 + 500) * 1000 + SECOND_US)
  })

  it("falls back to request_time + 5s when llm_call has neither complete nor response time", () => {
    const row = baseLlmCallDetail({
      request_time: 4_000_000,
      complete_time: undefined as unknown as number,
      response_time: undefined as unknown as number,
    })
    const v = defaultsFor({ type: "llm_call", row })
    expect(v.end_us).toBe((4_000_000 + 5_000) * 1000 + SECOND_US)
  })

  it("builds initial values from an agent_turn anchor — ports intentionally blank", () => {
    const row = baseAgentTurnDetail({
      source_id: "src-3",
      client_ip: "10.0.0.11",
      server_ip: "10.0.0.3",
      start_time: 5_000,
      end_time: 5_000 + 4,
    })
    const v = defaultsFor({ type: "agent_turn", row })
    expect(v.source_id).toBe("src-3")
    expect(v.client_ip).toBe("10.0.0.11")
    expect(v.server_ip).toBe("10.0.0.3")
    // Ports intentionally blank — turns span connections.
    expect(v.client_port).toBe("")
    expect(v.server_port).toBe("")
    expect(v.start_us).toBe(5_000 * 1000 - SECOND_US)
    expect(v.end_us).toBe((5_000 + 4) * 1000 + SECOND_US)
  })
})

describe("validate", () => {
  const base: ExtractFormValues = {
    source_id: "src",
    client_ip: "10.0.0.1",
    client_port: "80",
    server_ip: "10.0.0.2",
    server_port: "443",
    start_us: 1_000 * SECOND_US,
    end_us: 2_000 * SECOND_US,
  }

  it("passes for a clean form", () => {
    expect(validate(base)).toEqual({ ok: true })
  })

  it("fails when start >= end", () => {
    const r = validate({ ...base, start_us: 10, end_us: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("start must be < end")
  })

  it("fails when the time window exceeds 1h", () => {
    const r = validate({ ...base, start_us: 0, end_us: 2 * 60 * 60 * SECOND_US })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("time window > 1h")
  })

  it("fails for a malformed client_ip", () => {
    const r = validate({ ...base, client_ip: "not-an-ip" })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("client_ip is malformed")
  })

  it("fails for a malformed server_ip", () => {
    // The cheap IPv4/IPv6 surface check passes "999.999.999.999" as IPv4-shaped,
    // so use a token that fails both the IPv4 regex and the IPv6/hostname regex.
    const r = validate({ ...base, server_ip: "not! an ip" })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("server_ip is malformed")
  })

  it("fails for a malformed client_port", () => {
    const r = validate({ ...base, client_port: "abc" })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("client_port is malformed")
  })

  it("fails for an out-of-range server_port", () => {
    const r = validate({ ...base, server_port: "99999" })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("server_port is malformed")
  })

  it("passes when client_port is empty (any)", () => {
    const r = validate({ ...base, client_port: "" })
    expect(r.ok).toBe(true)
  })

  it("passes when server_ip is empty (any)", () => {
    const r = validate({ ...base, server_ip: "" })
    expect(r.ok).toBe(true)
  })

  it("passes for a valid IPv6-looking client_ip", () => {
    const r = validate({ ...base, client_ip: "::1" })
    expect(r.ok).toBe(true)
  })
})

describe("buildExtractUrl", () => {
  it("encodes all populated fields into /api/pcap/extract", () => {
    const url = buildExtractUrl({
      source_id: "src-1",
      client_ip: "10.0.0.9",
      client_port: "54000",
      server_ip: "10.0.0.1",
      server_port: "8080",
      start_us: 1,
      end_us: 2,
    })
    expect(url.startsWith("/api/pcap/extract?")).toBe(true)
    const qs = new URLSearchParams(url.split("?")[1]!)
    expect(qs.get("source_id")).toBe("src-1")
    expect(qs.get("client_ip")).toBe("10.0.0.9")
    expect(qs.get("client_port")).toBe("54000")
    expect(qs.get("server_ip")).toBe("10.0.0.1")
    expect(qs.get("server_port")).toBe("8080")
    expect(qs.get("start")).toBe("1")
    expect(qs.get("end")).toBe("2")
  })

  it("omits empty optional fields", () => {
    const url = buildExtractUrl({
      source_id: "src-1",
      client_ip: "",
      client_port: "",
      server_ip: "",
      server_port: "",
      start_us: 1,
      end_us: 2,
    })
    const qs = new URLSearchParams(url.split("?")[1]!)
    expect(qs.has("client_ip")).toBe(false)
    expect(qs.has("client_port")).toBe(false)
    expect(qs.has("server_ip")).toBe(false)
    expect(qs.has("server_port")).toBe(false)
    // source_id, start, end are always present.
    expect(qs.get("source_id")).toBe("src-1")
    expect(qs.get("start")).toBe("1")
    expect(qs.get("end")).toBe("2")
  })
})
