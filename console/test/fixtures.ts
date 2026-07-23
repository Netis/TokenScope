/**
 * Seed-data builders for console component/page tests. Lives under
 * `console/test/` (outside `src/`) so it never enters the production build
 * typecheck or the coverage denominator.
 *
 * Every builder returns a *mutable* object with sensible defaults; spread or
 * override the fields a test cares about. The shapes mirror `@/types/api`.
 *
 *   import { baseMetricsSummary, renderPage } from "../../test/fixtures"
 *   const qc = createTestQueryClient()
 *   setQueryData(qc, ["metrics-summary", {…}], baseMetricsSummary())
 *   renderPage(<OverviewPage />, { queryClient: qc })
 */
import * as React from "react"
import type { ReactNode } from "react"
import { MemoryRouter, type MemoryRouterProps } from "react-router"
import { render, type RenderResult } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createTestQueryClient,
  resetStore,
} from "./mocks"
import { useToolbarStore } from "@/stores/toolbar"
import type {
  AgentActivityData,
  AgentSummaryData,
  AgentTurnCallItem,
  AgentTurnDetail,
  AgentTurnListItem,
  AgentTurnsPage,
  AppConfigShape,
  CaptureInterfacesResponse,
  HttpExchangeDetail,
  HttpExchangeListItem,
  HttpExchangesPage,
  InternalMetricsResponse,
  InternalMetricsSeriesResponse,
  LlmCallDetail,
  LlmCallListItem,
  LlmCallsPage,
  MetricsSummary,
  ModelsData,
  RuntimeConfigResponse,
  ServiceRow,
  ServicesData,
  ServicesTopology,
  SessionDetail,
  SessionListItem,
  SessionTurnItem,
  SessionTurnsPage,
  SessionsPage,
  TimeseriesData,
} from "@/types/api"

// ── toolbar default window ─────────────────────────────────────────────────
export const NOW_S = 1_780_000_000
export const WINDOW_START_S = NOW_S - 3600
export const WINDOW_START_MS = WINDOW_START_S * 1000
export const NOW_MS = NOW_S * 1000

/** Reset the toolbar store to a deterministic 1h window ending at NOW_S. */
export function resetToolbarWindow(start = WINDOW_START_S, end = NOW_S): void {
  resetStore(useToolbarStore, {
    preset: "1h",
    start,
    end,
    filters: { wireApi: "", model: "", serverIp: "" },
    refreshInterval: 5000,
  })
}

// ── metrics ─────────────────────────────────────────────────────────────────
export function baseMetricsSummary(over: Partial<MetricsSummary> = {}): MetricsSummary {
  return {
    call_count: 100,
    error_count: 5,
    error_4xx_count: 2,
    error_429_count: 1,
    error_5xx_count: 2,
    total_input_tokens: 12000,
    total_output_tokens: 8000,
    ttft_avg: 320.5,
    e2e_avg: 2100.0,
    tpot_avg: 45.0,
    ...over,
  }
}

export function baseTimeseries(over: Partial<TimeseriesData> = {}): TimeseriesData {
  const timestamps = [NOW_S - 600, NOW_S - 300, NOW_S]
  return {
    timestamps,
    series: [
      { name: "call_count", group: "anthropic", values: [10, 20, 30] },
      { name: "call_count", group: "openai-chat", values: [5, 8, 12] },
    ],
    ...over,
  }
}

export function baseModelsData(over: Partial<ModelsData> = {}): ModelsData {
  return {
    models: [
      {
        wire_api: "anthropic",
        model: "claude-sonnet-4",
        call_count: 60,
        error_count: 2,
        error_4xx_count: 1,
        error_429_count: 0,
        error_5xx_count: 1,
        total_input_tokens: 7000,
        total_output_tokens: 5000,
        ttft_avg: 300,
        ttft_p95: 600,
        e2e_avg: 2000,
        e2e_p95: 4000,
        tpot_avg: 40,
      },
      {
        wire_api: "openai-chat",
        model: "gpt-4o",
        call_count: 40,
        error_count: 3,
        error_4xx_count: 1,
        error_429_count: 1,
        error_5xx_count: 1,
        total_input_tokens: 5000,
        total_output_tokens: 3000,
        ttft_avg: 250,
        ttft_p95: 500,
        e2e_avg: 1500,
        e2e_p95: 3000,
        tpot_avg: 50,
      },
    ],
    ...over,
  }
}

// ── agent overview ──────────────────────────────────────────────────────────
export function baseAgentActivity(over: Partial<AgentActivityData> = {}): AgentActivityData {
  return {
    points: [
      { timestamp_ms: NOW_MS - 600_000, agent_kind: "claude-cli", turn_count: 3 },
      { timestamp_ms: NOW_MS - 300_000, agent_kind: "claude-cli", turn_count: 5 },
    ],
    ...over,
  }
}

export function baseAgentSummary(over: Partial<AgentSummaryData> = {}): AgentSummaryData {
  return {
    summary: [
      {
        agent_kind: "claude-cli",
        turn_count: 12,
        total_input_tokens: 9000,
        total_output_tokens: 6000,
        avg_duration_ms: 4200,
        last_seen_ms: NOW_MS,
      },
    ],
    ...over,
  }
}

// ── internal metrics ────────────────────────────────────────────────────────
export function baseInternalMetrics(over: Partial<InternalMetricsResponse> = {}): InternalMetricsResponse {
  return {
    ts: NOW_MS,
    pipelines: [
      {
        name: "default",
        metrics: [
          { name: "flows_active", group: "capture", kind: "gauge", value: 42 },
          { name: "agent_turns_open", group: "turn", kind: "gauge", value: 7 },
        ],
      },
    ],
    global: { metrics: [{ name: "mem_rss_bytes", group: "storage", kind: "gauge", value: 1_000_000 }] },
    ...over,
  }
}

export function baseInternalMetricsSeries(
  over: Partial<InternalMetricsSeriesResponse> = {},
): InternalMetricsSeriesResponse {
  return {
    ts: NOW_MS,
    series: [
      {
        name: "flows_active",
        group: "capture",
        points: [
          { t: NOW_MS - 60_000, v: 30 },
          { t: NOW_MS, v: 42 },
        ],
      },
      {
        name: "agent_turns_open",
        group: "turn",
        points: [
          { t: NOW_MS - 60_000, v: 5 },
          { t: NOW_MS, v: 7 },
        ],
      },
    ],
    ...over,
  }
}

// ── services ─────────────────────────────────────────────────────────────────
export function baseServiceRow(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    server_ip: "10.0.0.1",
    server_port: 8080,
    models: ["gpt-4o", "claude-sonnet-4"],
    wire_apis: ["openai-chat", "anthropic"],
    request_paths: ["/v1/chat/completions", "/v1/messages"],
    call_count: 50,
    error_count: 2,
    stream_count: 45,
    total_input_tokens: 6000,
    total_output_tokens: 4000,
    ttft_avg_ms: 300,
    ttft_p95_ms: 600,
    e2e_avg_ms: 2000,
    e2e_p95_ms: 4000,
    first_seen_ms: NOW_MS - 3_600_000,
    last_seen_ms: NOW_MS,
    app: "openai-compat",
    server_header: "uvicorn",
    ...over,
  }
}

export function baseServicesData(over: Partial<ServicesData> = {}): ServicesData {
  return { services: [baseServiceRow()], ...over }
}

export function baseServicesTopology(over: Partial<ServicesTopology> = {}): ServicesTopology {
  return {
    nodes: [
      { server_ip: "10.0.0.1", server_port: 8080, app: "openai-compat", models: ["gpt-4o"], call_count: 50 },
      { server_ip: "__clients__", server_port: 0, app: null, models: [], call_count: 50 },
    ],
    edges: [
      { from_ip: "__clients__", from_port: 0, to_ip: "10.0.0.1", to_port: 8080, turn_count: 12, kind: "client" },
    ],
    ...over,
  }
}

export function baseCaptureInterfaces(over: Partial<CaptureInterfacesResponse> = {}): CaptureInterfacesResponse {
  return {
    interfaces: [
      {
        name: "eth0",
        description: "primary",
        addresses: ["10.0.0.5"],
        is_up: true,
        is_running: true,
        is_loopback: false,
        is_wireless: false,
      },
    ],
    ...over,
  }
}

// ── runtime config ──────────────────────────────────────────────────────────
export function baseRuntimeConfig(over: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
  const config: AppConfigShape = {
    pipelines: [
      {
        name: "default",
        sources: [
          {
            type: "pcap",
            interface: "eth0",
            bpf_filter: null,
            snaplen: 65535,
            source_id: null,
          },
        ],
      },
    ],
  }
  return {
    loaded_at_ms: NOW_MS,
    config_path: "/etc/heron/default.toml",
    version: "0.7.1",
    ebpf_available: false,
    config,
    ...over,
  }
}

// ── llm calls ────────────────────────────────────────────────────────────────
export function baseLlmCallListItem(over: Partial<LlmCallListItem> = {}): LlmCallListItem {
  return {
    id: "call-1",
    request_time: NOW_MS,
    wire_api: "anthropic",
    model: "claude-sonnet-4",
    status_code: 200,
    is_stream: true,
    finish_reason: "end_turn",
    ttft_ms: 300,
    e2e_latency_ms: 2100,
    input_tokens: 1200,
    output_tokens: 800,
    tokens_estimated: false,
    client_ip: "10.0.0.9",
    server_ip: "10.0.0.1",
    server_port: 8080,
    request_path: "/v1/messages",
    is_agent_request: true,
    tool_surface: "function_call",
    agent_topology: "single_agent",
    tool_call_count: 1,
    tool_names: ["get_weather"],
    process: null,
    ...over,
  }
}

export function baseLlmCallsPage(over: Partial<LlmCallsPage> = {}): LlmCallsPage {
  return {
    total: 1,
    items: [baseLlmCallListItem()],
    ...over,
  }
}

export function baseLlmCallDetail(over: Partial<LlmCallDetail> = {}): LlmCallDetail {
  return {
    id: "call-1",
    source_id: "src-1",
    request_time: NOW_MS,
    response_time: NOW_MS + 300,
    complete_time: NOW_MS + 2100,
    wire_api: "anthropic",
    model: "claude-sonnet-4",
    api_type: "anthropic",
    is_stream: true,
    request_path: "/v1/messages",
    status_code: 200,
    finish_reason: "end_turn",
    input_tokens: 1200,
    output_tokens: 800,
    total_tokens: 2000,
    tokens_estimated: false,
    ttft_ms: 300,
    e2e_latency_ms: 2100,
    response_id: "resp_1",
    client_ip: "10.0.0.9",
    client_port: 54000,
    server_ip: "10.0.0.1",
    server_port: 8080,
    request_body: JSON.stringify({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
    }),
    response_body: JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "Hi there" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 800 },
    }),
    request_headers: JSON.stringify([["content-type", "application/json"]]),
    response_headers: JSON.stringify([["content-type", "text/event-stream"]]),
    is_agent_request: true,
    tool_surface: "function_call",
    agent_topology: "single_agent",
    tool_call_count: 0,
    tool_names: [],
    process: null,
    ...over,
  }
}

// ── http exchanges ───────────────────────────────────────────────────────────
export function baseHttpExchangeListItem(over: Partial<HttpExchangeListItem> = {}): HttpExchangeListItem {
  return {
    id: "ex-1",
    source_id: "src-1",
    request_time: NOW_MS,
    method: "POST",
    uri: "/v1/chat/completions",
    client_ip: "10.0.0.9",
    server_ip: "10.0.0.1",
    server_port: 8080,
    status: 200,
    is_sse: true,
    duration_ms: 2100,
    ...over,
  }
}

export function baseHttpExchangesPage(over: Partial<HttpExchangesPage> = {}): HttpExchangesPage {
  return { total: 1, items: [baseHttpExchangeListItem()], ...over }
}

export function baseHttpExchangeDetail(over: Partial<HttpExchangeDetail> = {}): HttpExchangeDetail {
  return {
    id: "ex-1",
    source_id: "src-1",
    client_ip: "10.0.0.9",
    client_port: 54000,
    server_ip: "10.0.0.1",
    server_port: 8080,
    method: "POST",
    uri: "/v1/chat/completions",
    request_headers: JSON.stringify([["content-type", "application/json"], ["authorization", "Bearer secret"]]),
    request_body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    status: 200,
    response_headers: JSON.stringify([["content-type", "text/event-stream"]]),
    response_body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    is_sse: true,
    sse_event_count: 1,
    sse_data_bytes: 40,
    request_time: NOW_MS,
    response_first_byte_time: NOW_MS + 300,
    response_complete_time: NOW_MS + 2100,
    ...over,
  }
}

// ── agent turns ──────────────────────────────────────────────────────────────
export function baseAgentTurnListItem(over: Partial<AgentTurnListItem> = {}): AgentTurnListItem {
  return {
    turn_id: "turn-1",
    session_id: "sess-1",
    start_time: NOW_S,
    end_time: NOW_S + 4,
    duration_ms: 4000,
    wire_api: "anthropic",
    agent_kind: "claude-cli",
    client_ip: "10.0.0.9",
    server_ip: "10.0.0.1",
    primary_model: "claude-sonnet-4",
    models_used: ["claude-sonnet-4"],
    call_count: 2,
    total_input_tokens: 2000,
    total_output_tokens: 1200,
    status: "complete",
    final_finish_reason: "end_turn",
    user_input_preview: "Hello world",
    final_answer_preview: "Hi there",
    tool_surfaces: ["function_call"],
    tool_call_total: 1,
    agent_topology: "single_agent",
    suspicious_skills: [],
    ...over,
  }
}

export function baseAgentTurnsPage(over: Partial<AgentTurnsPage> = {}): AgentTurnsPage {
  return { total: 1, items: [baseAgentTurnListItem()], ...over }
}

export function baseAgentTurnDetail(over: Partial<AgentTurnDetail> = {}): AgentTurnDetail {
  return {
    turn_id: "turn-1",
    source_id: "src-1",
    session_id: "sess-1",
    wire_api: "anthropic",
    agent_kind: "claude-cli",
    client_ip: "10.0.0.9",
    server_ip: "10.0.0.1",
    start_time: NOW_S,
    end_time: NOW_S + 4,
    duration_ms: 4000,
    call_count: 2,
    models_used: ["claude-sonnet-4"],
    subagents_used: [],
    total_input_tokens: 2000,
    total_output_tokens: 1200,
    total_cached_input_tokens: 0,
    total_cost_usd: 0.05,
    status: "complete",
    final_finish_reason: "end_turn",
    user_call_id: "call-1",
    user_input: "Hello world",
    final_call_id: "call-2",
    final_answer: "Hi there",
    span_ids: ["call-1", "call-2"],
    metadata: {},
    tool_surfaces: ["function_call"],
    tool_call_total: 1,
    agent_topology: "single_agent",
    suspicious_skills: [],
    ...over,
  }
}

export function baseAgentTurnCallItem(over: Partial<AgentTurnCallItem> = {}): AgentTurnCallItem {
  return {
    id: "call-1",
    sequence: 1,
    request_time: NOW_MS,
    response_time: NOW_MS + 300,
    complete_time: NOW_MS + 2100,
    wire_api: "anthropic",
    model: "claude-sonnet-4",
    status_code: 200,
    is_stream: true,
    finish_reason: "end_turn",
    ttft_ms: 300,
    e2e_latency_ms: 2100,
    input_tokens: 1200,
    output_tokens: 800,
    request_path: "/v1/messages",
    client_ip: "10.0.0.9",
    client_port: 54000,
    server_ip: "10.0.0.1",
    server_port: 8080,
    request_body: JSON.stringify({ model: "claude-sonnet-4", messages: [{ role: "user", content: "Hello" }] }),
    response_body: JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }),
    request_headers: JSON.stringify([["content-type", "application/json"]]),
    response_headers: JSON.stringify([["content-type", "text/event-stream"]]),
    is_agent_request: true,
    tool_surface: "function_call",
    agent_topology: "single_agent",
    tool_call_count: 0,
    tool_names: [],
    ...over,
  }
}

// ── sessions ──────────────────────────────────────────────────────────────────
export function baseSessionListItem(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    source_id: "src-1",
    session_id: "sess-1",
    agent_kind: "claude-cli",
    last_turn_at_in_window: NOW_MS,
    first_turn_at: NOW_MS - 3_600_000,
    last_turn_at: NOW_MS,
    turn_count: 5,
    call_count: 12,
    total_input_tokens: 9000,
    total_output_tokens: 6000,
    total_cache_read_input_tokens: 1000,
    total_cache_creation_input_tokens: 500,
    total_cost_usd: 0.12,
    first_user_input_preview: "Hello world",
    first_user_call_id: "call-1",
    ...over,
  }
}

export function baseSessionsPage(over: Partial<SessionsPage> = {}): SessionsPage {
  return { items: [baseSessionListItem()], next_cursor: null, ...over }
}

export function baseSessionDetail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    source_id: "src-1",
    session_id: "sess-1",
    agent_kind: "claude-cli",
    first_turn_at: NOW_MS - 3_600_000,
    last_turn_at: NOW_MS,
    turn_count: 5,
    call_count: 12,
    total_input_tokens: 9000,
    total_output_tokens: 6000,
    total_cache_read_input_tokens: 1000,
    total_cache_creation_input_tokens: 500,
    total_cost_usd: 0.12,
    first_user_input_preview: "Hello world",
    first_user_call_id: "call-1",
    ...over,
  }
}

export function baseSessionTurnItem(over: Partial<SessionTurnItem> = {}): SessionTurnItem {
  return {
    turn_id: "turn-1",
    source_id: "src-1",
    session_id: "sess-1",
    start_time: NOW_S,
    end_time: NOW_S + 4,
    duration_ms: 4000,
    wire_api: "anthropic",
    agent_kind: "claude-cli",
    primary_model: "claude-sonnet-4",
    models_used: ["claude-sonnet-4"],
    call_count: 2,
    total_input_tokens: 2000,
    total_output_tokens: 1200,
    status: "complete",
    final_finish_reason: "end_turn",
    user_input: "Hello world",
    final_answer: "Hi there",
    tool_surfaces: ["function_call"],
    tool_call_total: 1,
    agent_topology: "single_agent",
    suspicious_skills: [],
    ...over,
  }
}

export function baseSessionTurnsPage(over: Partial<SessionTurnsPage> = {}): SessionTurnsPage {
  return { items: [baseSessionTurnItem()], next_cursor: null, ...over }
}

// ── render helpers ───────────────────────────────────────────────────────────
interface RenderPageOptions {
  queryClient?: QueryClient
  initialEntries?: MemoryRouterProps["initialEntries"]
}

/**
 * Render a page (or any node) wrapped in MemoryRouter + QueryClientProvider,
 * with the toolbar store reset to the deterministic window. The default window
 * (NOW_S-3600 … NOW_S) matches the query-key seeds built from
 * `useSupportedFilterParams` under `useToolbarStore` defaults.
 *
 * Pass `initialEntries` for pages that read `useSearchParams` / `useParams`
 * (e.g. `["/llm-calls?wire_api=anthropic"]`, `["/agent-turns/turn-1"]`).
 */
export function renderPage(ui: ReactNode, opts: RenderPageOptions = {}): RenderResult {
  resetToolbarWindow()
  const queryClient = opts.queryClient ?? createTestQueryClient()
  const initialEntries = opts.initialEntries ?? ["/"]
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(
      MemoryRouter,
      { initialEntries },
      React.createElement(QueryClientProvider, { client: queryClient }, children),
    )
  return render(ui, { wrapper })
}
