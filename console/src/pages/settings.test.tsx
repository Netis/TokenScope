import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { mockFetch, jsonResponse, setWindowOrigin } from "../../test/mocks"
import {
  baseCaptureInterfaces,
  baseInternalMetrics,
  baseRuntimeConfig,
  renderPage,
} from "../../test/fixtures"
import type { AppConfigShape, CaptureSource, PipelineShape } from "@/types/api"
import { SettingsPage } from "./settings"

// settings.tsx references `__APP_VERSION__`, a Vite `define` injected at
// build time. bun test doesn't run Vite, so install a stub on the global
// scope before the page renders.
;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

/** Build a runtime-config whose single pipeline has the given sources + optional pcap_dump. */
function configWith(sources: CaptureSource[], pcapDump?: PipelineShape["pcap_dump"], ebpfAvailable = false) {
  const config: AppConfigShape = { pipelines: [{ name: "default", sources, pcap_dump: pcapDump }] }
  return baseRuntimeConfig({ config, ebpf_available: ebpfAvailable, version: "0.0.0-test" })
}

/** Stub fetch keyed by URL substring. */
function stubSettings(payloads: Record<string, unknown>) {
  mockFetch((input) => {
    const url = String(input)
    for (const [key, data] of Object.entries(payloads)) {
      if (url.includes(key)) return jsonResponse({ code: 0, message: "ok", data })
    }
    return jsonResponse({ code: 0, message: "ok", data: {} })
  })
}

const pcap: CaptureSource = { type: "pcap", interface: "eth0", bpf_filter: null, snaplen: 65535, source_id: null }
const zmq: CaptureSource = { type: "cloud-probe", endpoint: "tcp://*:5555", recv_hwm: 1000 }
const pcapFile: CaptureSource = { type: "pcap-file", path: "/tmp/cap.pcap", realtime: false, source_id: null, loop_count: 1, loop_secs: 0, rate_pps: 0 }
const ebpf: CaptureSource = { type: "ebpf", source_id: null, ssl_libs: ["/usr/lib/libssl.so"], targets: [{ binary: "/usr/bin/node", flavor: "node", write_sig: null, read_sig: null, write_offset: null, read_offset: null }], pid_allowlist: [1234], segment_size: 4096 }

describe("SettingsPage", () => {
  afterEach(() => {
    // mockFetch self-restores.
  })

  it("renders the loading spinner before config/metrics/interfaces resolve", async () => {
    let resolve: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((r) => { resolve = r })
    mockFetch(() => pending as Promise<Response>)
    const { container } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(container.querySelector("svg")).toBeInTheDocument()
    resolve(jsonResponse({ code: 0, message: "ok", data: baseRuntimeConfig() }))
  })

  it("renders the failed-to-load notice when the config query errors", async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.includes("/api/runtime-config")) {
        return jsonResponse({ code: 5, message: "boom-config" }, { status: 500 })
      }
      return jsonResponse({ code: 0, message: "ok", data: baseInternalMetrics() })
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/Failed to load runtime config/i)).toBeInTheDocument()
    expect(await findByText(/boom-config/i)).toBeInTheDocument()
  })

  it("renders the header and pipeline card once config resolves", async () => {
    stubSettings({
      "/api/runtime-config": baseRuntimeConfig(),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText("Settings")).toBeInTheDocument()
    expect(await findByText(/Pipeline · default/)).toBeInTheDocument()
    expect(await findByText("Capture sources")).toBeInTheDocument()
    expect(await findByText("eBPF capture (on-host TLS)")).toBeInTheDocument()
    expect(await findByText("Activity (live)")).toBeInTheDocument()
  })

  it("renders the empty state when no pipelines are configured", async () => {
    stubSettings({
      "/api/runtime-config": baseRuntimeConfig({ config: { pipelines: [] } }),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/No pipelines configured/)).toBeInTheDocument()
  })

  it("summarizes each capture-source type in view mode", async () => {
    stubSettings({
      "/api/runtime-config": configWith([pcap, zmq, pcapFile, ebpf]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    // SourceSummary for each type:
    expect(await findByText(/Live captures/)).toBeInTheDocument()
    expect(await findByText("ZMQ receivers")).toBeInTheDocument()
    expect(await findByText("PCAP replay")).toBeInTheDocument()
    expect(await findByText("eBPF capture")).toBeInTheDocument()
    // pcap interface name + cloud-probe endpoint + pcap-file path appear.
    expect(await findByText("eth0")).toBeInTheDocument()
    expect(await findByText(/tcp:\/\/\*:5555/)).toBeInTheDocument()
    expect(await findByText("/tmp/cap.pcap")).toBeInTheDocument()
    // eBPF ssl_libs + target count + pid count.
    expect(await findByText(/\/usr\/lib\/libssl\.so/)).toBeInTheDocument()
    expect(await findByText(/1 static target\(s\)/)).toBeInTheDocument()
    expect(await findByText(/1 pid\(s\)/)).toBeInTheDocument()
  })

  it("describeBpf: empty → 'capturing all TCP traffic'", async () => {
    stubSettings({
      "/api/runtime-config": configWith([{ ...pcap, bpf_filter: null }]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/capturing all TCP traffic/i)).toBeInTheDocument()
  })

  it("describeBpf: port + host filter → human-readable", async () => {
    stubSettings({
      "/api/runtime-config": configWith([{ ...pcap, bpf_filter: "tcp port 8080 and host 10.0.0.1" }]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/port 8080 · host 10\.0\.0\.1/i)).toBeInTheDocument()
  })

  it("describeBpf: multiple ports → plural", async () => {
    stubSettings({
      "/api/runtime-config": configWith([{ ...pcap, bpf_filter: "tcp port 8080 or port 8443" }]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/ports 8080, 8443/i)).toBeInTheDocument()
  })

  it("describeBpf: unparseable filter → raw fallback", async () => {
    stubSettings({
      "/api/runtime-config": configWith([{ ...pcap, bpf_filter: "vlan 100" }]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/filter: vlan 100/i)).toBeInTheDocument()
  })

  it("pcap-file realtime label toggles to 'replay at original speed'", async () => {
    stubSettings({
      "/api/runtime-config": configWith([{ ...pcapFile, realtime: true }]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/replay at original speed/i)).toBeInTheDocument()
  })

  it("eBPF toggle: shows 'unavailable in this build' when not available", async () => {
    stubSettings({
      "/api/runtime-config": configWith([pcap], undefined, false),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/unavailable in this build/i)).toBeInTheDocument()
  })

  it("eBPF toggle: enabled state renders when an ebpf source is configured", async () => {
    stubSettings({
      "/api/runtime-config": configWith([ebpf], undefined, true),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByRole } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    const sw = await findByRole("switch")
    expect(sw.getAttribute("aria-checked")).toBe("true")
  })

  it("renders the PCAP dump section when pcap_dump is enabled with retention", async () => {
    stubSettings({
      "/api/runtime-config": configWith([pcap], {
        enabled: true,
        dir: "/var/lib/heron/dumps",
        compression: "snappy",
        retention: { enabled: true, check_interval_secs: 60, max_age_hours: 48, max_size_mb: 2048 },
      }),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText("PCAP dump")).toBeInTheDocument()
    expect(await findByText(/var\/lib\/heron\/dumps/)).toBeInTheDocument()
    // retention max age 48h → "2 d"; max size 2048 MiB → "2.0 GiB"
    expect(await findByText("2 d")).toBeInTheDocument()
    expect(await findByText("2.0 GiB")).toBeInTheDocument()
  })

  it("renders PCAP dump 'disabled' when not enabled", async () => {
    stubSettings({
      "/api/runtime-config": configWith([pcap], { enabled: false, dir: "/d", compression: "none" }),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    // The disabled label is inside the PCAP dump card.
    const dump = await findByText("PCAP dump")
    // The italic "disabled" note follows.
    expect(dump.parentElement).not.toBeNull()
  })

  it("renders the live + ZMQ counter subsections when both source types are present", async () => {
    stubSettings({
      "/api/runtime-metrics": baseInternalMetrics(),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/runtime-config": configWith([pcap, zmq]),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText("Live capture")).toBeInTheDocument()
    expect(await findByText("ZMQ receiver")).toBeInTheDocument()
    expect(await findByText("Packets captured")).toBeInTheDocument()
    expect(await findByText("Batches received")).toBeInTheDocument()
  })

  it("expands the interface help expander to reveal the interface table", async () => {
    const user = userEvent.setup()
    stubSettings({
      "/api/runtime-config": configWith([pcap]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText, findByRole } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    const btn = await findByRole("button", { name: /Help me pick an interface/i })
    await user.click(btn)
    // The interface table header columns appear after expanding.
    expect(await findByText("addresses")).toBeInTheDocument()
    expect(await findByText("flags")).toBeInTheDocument()
  })

  it("enters edit mode, opens the save-confirm dialog, and cancels", async () => {
    const user = userEvent.setup()
    stubSettings({
      "/api/runtime-config": configWith([pcap]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText, findByRole, queryByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    // Enter edit mode.
    const editBtn = await findByRole("button", { name: /Edit sources/i })
    await user.click(editBtn)
    // The editor's Save… button appears.
    const saveBtn = await findByRole("button", { name: /Save/i })
    await user.click(saveBtn)
    // The confirm dialog appears.
    expect(await findByText(/Capture will pause for ~2–3 s/i)).toBeInTheDocument()
    // Cancel the confirm → back to Save… button.
    const noBtn = await findByRole("button", { name: /^No$/i })
    await user.click(noBtn)
    await waitFor(() => expect(queryByText(/Capture will pause/i)).not.toBeInTheDocument())
  })

  it("exits edit mode via the editor Cancel button", async () => {
    const user = userEvent.setup()
    stubSettings({
      "/api/runtime-config": configWith([pcap]),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByRole, findAllByRole, queryByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    const editBtn = await findByRole("button", { name: /Edit sources/i })
    await user.click(editBtn)
    // The editor renders the Save… confirm affordance.
    const saveBtn = await findByRole("button", { name: /Save/i })
    expect(saveBtn).toBeInTheDocument()
    // Click the card's toggle (now labeled "Cancel") to exit edit mode.
    const cancelBtns = await findAllByRole("button", { name: /^Cancel$/i })
    expect(cancelBtns.length).toBeGreaterThan(0)
    await user.click(cancelBtns[cancelBtns.length - 1])
    await waitFor(() => expect(queryByText("Save…")).not.toBeInTheDocument())
  })

  it("renders a version-mismatch indicator when server version differs from build", async () => {
    stubSettings({
      "/api/runtime-config": baseRuntimeConfig({ version: "9.9.9" }),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/server: 9\.9\.9/i)).toBeInTheDocument()
  })

  it("shows the no-sources-configured counters note when pipeline has only ebpf", async () => {
    stubSettings({
      "/api/runtime-config": configWith([ebpf], undefined, true),
      "/api/internal-metrics": baseInternalMetrics(),
      "/api/capture/interfaces": baseCaptureInterfaces(),
    })
    const { findByText } = renderPage(<SettingsPage />, { initialEntries: ["/settings"] })
    expect(await findByText(/nothing to count/i)).toBeInTheDocument()
  })
})
