import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseInternalMetrics, renderPage } from "../../test/fixtures"
import { usePipelineHealthStore } from "@/stores/pipeline-health"
import { PipelineHealthPage } from "./debug-pipeline-health"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubPipeline(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("PipelineHealthPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
    // Reset the pipeline-health store so interval/selection don't leak.
    usePipelineHealthStore.setState({
      intervalMs: 2000,
      selectedPipeline: null,
      tableGroupFilter: "all",
      tableOnlyWarn: false,
    })
  })

  it("renders the loading spinner before metrics resolve", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderPage(<PipelineHealthPage />, {
      initialEntries: ["/debug/pipeline-health"],
    })
    // lucide Loader2 renders an svg while loading.
    expect(container.querySelector("svg")).toBeInTheDocument()
    resolve(jsonResponse({ code: 0, message: "ok", data: baseInternalMetrics() }))
  })

  it("renders the header and pipeline sections once metrics resolve", async () => {
    stubPipeline({
      "/api/internal-metrics": baseInternalMetrics(),
    })
    const { findByText } = renderPage(<PipelineHealthPage />, {
      initialEntries: ["/debug/pipeline-health"],
    })
    expect(await findByText("Pipeline Health")).toBeInTheDocument()
    // The default pipeline is "default" — renders as a static badge (only
    // one pipeline).
    expect(await findByText("default")).toBeInTheDocument()
  })

  it("renders the 'No active pipelines' state when pipelines is empty", async () => {
    stubPipeline({
      "/api/internal-metrics": baseInternalMetrics({ pipelines: [] }),
    })
    const { findByText } = renderPage(<PipelineHealthPage />, {
      initialEntries: ["/debug/pipeline-health"],
    })
    expect(await findByText("No active pipelines")).toBeInTheDocument()
  })
})
