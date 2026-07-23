import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import { baseModelsData, baseServiceRow, baseServicesData, baseServicesTopology, renderPage } from "../../test/fixtures"
import { ServicesPage } from "./services"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Stub fetch keyed by URL substring. */
function stubServices(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

describe("ServicesPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the table view with the service row", async () => {
    stubServices({
      "/api/services/topology": baseServicesTopology(),
      "/api/services": baseServicesData(),
    })
    const { findByText } = renderPage(<ServicesPage />, { initialEntries: ["/services"] })
    expect(await findByText("Endpoint")).toBeInTheDocument()
    expect(await findByText("10.0.0.1")).toBeInTheDocument()
    expect(await findByText("openai-compat")).toBeInTheDocument()
  })

  it("renders the empty state when no services are returned", async () => {
    stubServices({
      "/api/services/topology": { nodes: [], edges: [] },
      "/api/services": { services: [] },
    })
    const { findByText } = renderPage(<ServicesPage />, { initialEntries: ["/services"] })
    expect(await findByText("No services found in selected time range")).toBeInTheDocument()
  })

  it("renders the loading state before data resolves", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderPage(<ServicesPage />, { initialEntries: ["/services"] })
    expect(container.textContent).toContain("Loading")
    resolve(jsonResponse({ code: 0, message: "ok", data: baseServicesData() }))
  })

  it("renders app badges for known apps (vllm, litellm) and unknown", async () => {
    stubServices({
      "/api/services/topology": baseServicesTopology(),
      "/api/services": {
        services: [
          baseServiceRow({ server_ip: "10.0.0.2", server_port: 8000, app: "vllm" }),
          baseServiceRow({ server_ip: "10.0.0.3", server_port: 8000, app: "litellm" }),
          baseServiceRow({ server_ip: "10.0.0.4", server_port: 8000, app: null, server_header: "nginx" }),
        ],
      },
    })
    const { findByText } = renderPage(<ServicesPage />, { initialEntries: ["/services"] })
    expect(await findByText("vllm")).toBeInTheDocument()
    expect(await findByText("litellm")).toBeInTheDocument()
    expect(await findByText("unknown")).toBeInTheDocument()
  })

  it("switches to the path view and renders the topology", async () => {
    const user = userEvent.setup()
    stubServices({
      "/api/services/topology": baseServicesTopology(),
      "/api/services": baseServicesData(),
    })
    const { findByText, findByRole, queryByText } = renderPage(<ServicesPage />, { initialEntries: ["/services"] })
    await findByText("Endpoint")
    await user.click(await findByRole("button", { name: /Path/i }))
    // PathViewContainer renders the topology; the table's Endpoint column is gone.
    await findByText(/10\.0\.0\.1/) // topology node label
    expect(queryByText("Endpoint")).not.toBeInTheDocument()
  })

  it("switches to the model view and renders the ModelsPage", async () => {
    const user = userEvent.setup()
    stubServices({
      "/api/services/topology": baseServicesTopology(),
      "/api/services": baseServicesData(),
      "/api/metrics/models": baseModelsData(),
    })
    const { findByText, findByRole } = renderPage(<ServicesPage />, { initialEntries: ["/services"] })
    await findByText("Endpoint")
    await user.click(await findByRole("button", { name: /Model/i }))
    // ModelsPage renders its comparison table header "Wire API".
    expect(await findByText("Wire API")).toBeInTheDocument()
  })

  it("sorts by a column header (Calls)", async () => {
    const user = userEvent.setup()
    stubServices({
      "/api/services/topology": baseServicesTopology(),
      "/api/services": {
        services: [
          baseServiceRow({ server_ip: "10.0.0.2", call_count: 5 }),
          baseServiceRow({ server_ip: "10.0.0.1", call_count: 50 }),
        ],
      },
    })
    const { findByText, getByText, getAllByText } = renderPage(<ServicesPage />, { initialEntries: ["/services"] })
    await findByText("Endpoint")
    // Click the "Calls" sort header.
    await user.click(getByText("Calls"))
    // Both server IPs still present.
    expect(getAllByText(/10\.0\.0\.[12]/).length).toBeGreaterThan(0)
  })
})

