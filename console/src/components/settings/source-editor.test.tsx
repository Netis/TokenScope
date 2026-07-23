import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { SourceEditorRow, defaultFor } from "./source-editor"
import type { CaptureInterface, CaptureSource } from "@/types/api"

afterEach(() => cleanup())

const INTERFACES: CaptureInterface[] = [
  { name: "any", description: null, addresses: [], is_up: true, is_running: true, is_loopback: false, is_wireless: false },
  { name: "eth0", description: "primary", addresses: ["10.0.0.1"], is_up: true, is_running: true, is_loopback: false, is_wireless: false },
  { name: "lo", description: null, addresses: ["127.0.0.1"], is_up: true, is_running: true, is_loopback: true, is_wireless: false },
  { name: "veth0", description: null, addresses: [], is_up: true, is_running: true, is_loopback: false, is_wireless: false },
]

/** Controlled Harness for SourceEditorRow — feeds onChange back into state
 *  so the form re-renders with the new source. */
function RowHarness({
  initial,
  interfaces = INTERFACES,
  onRemove = () => {},
}: {
  initial: CaptureSource
  interfaces?: CaptureInterface[]
  onRemove?: () => void
}) {
  const [source, setSource] = React.useState<CaptureSource>(initial)
  return (
    <SourceEditorRow
      source={source}
      interfaces={interfaces}
      onChange={setSource}
      onRemove={onRemove}
    />
  )
}

describe("defaultFor", () => {
  it("returns a pcap source with the default LLM-ports BPF and snaplen", () => {
    const s = defaultFor("pcap")
    expect(s.type).toBe("pcap")
    if (s.type === "pcap") {
      expect(s.interface).toBe("any")
      expect(s.snaplen).toBe(262_144)
      expect(s.bpf_filter).toContain("tcp port 8080")
      expect(s.bpf_filter).toContain("tcp port 11434")
      expect(s.source_id).toBeNull()
    }
  })

  it("returns a pcap-file source with realtime=false and loop_count=1", () => {
    const s = defaultFor("pcap-file")
    expect(s.type).toBe("pcap-file")
    if (s.type === "pcap-file") {
      expect(s.path).toBe("")
      expect(s.realtime).toBe(false)
      expect(s.source_id).toBeNull()
      expect(s.loop_count).toBe(1)
      expect(s.loop_secs).toBe(0)
      expect(s.rate_pps).toBe(0)
    }
  })

  it("returns a cloud-probe source with the default TCP endpoint and hwm", () => {
    const s = defaultFor("cloud-probe")
    expect(s.type).toBe("cloud-probe")
    if (s.type === "cloud-probe") {
      expect(s.endpoint).toBe("tcp://0.0.0.0:5555")
      expect(s.recv_hwm).toBe(1000)
    }
  })

  it("returns an ebpf source with empty lists and segment_size=16384", () => {
    const s = defaultFor("ebpf")
    expect(s.type).toBe("ebpf")
    if (s.type === "ebpf") {
      expect(s.source_id).toBeNull()
      expect(s.ssl_libs).toEqual([])
      expect(s.targets).toEqual([])
      expect(s.pid_allowlist).toEqual([])
      expect(s.segment_size).toBe(16384)
    }
  })
})

describe("SourceEditorRow", () => {
  it("renders the pcap row heading", () => {
    const { container } = render(<RowHarness initial={defaultFor("pcap")} />)
    expect(container.textContent).toContain("Live capture from local interface")
  })

  it("renders the cloud-probe row heading", () => {
    const { container } = render(<RowHarness initial={defaultFor("cloud-probe")} />)
    expect(container.textContent).toContain("ZMQ receiver for remote probe stream")
  })

  it("renders the pcap-file row heading", () => {
    const { container } = render(<RowHarness initial={defaultFor("pcap-file")} />)
    expect(container.textContent).toContain("PCAP file replay")
  })

  it("renders the ebpf row heading", () => {
    const { container } = render(<RowHarness initial={defaultFor("ebpf")} />)
    expect(container.textContent).toContain("eBPF SSL-uprobe capture")
  })

  it("removes the source when the trash button is clicked", async () => {
    const user = userEvent.setup()
    let removed = 0
    const { container } = render(
      <RowHarness initial={defaultFor("pcap")} onRemove={() => (removed++)} />,
    )
    const trash = container.querySelector('button[title="Remove this source"]') as HTMLButtonElement
    expect(trash).not.toBeNull()
    await user.click(trash)
    expect(removed).toBe(1)
  })
})

describe("PcapForm (via SourceEditorRow)", () => {
  it("renders the structured editor with ports/hosts inputs by default for a parseable BPF", () => {
    const { container } = render(<RowHarness initial={defaultFor("pcap")} />)
    expect(container.textContent).toContain("What to capture")
    expect(container.textContent).toContain("Ports (TCP)")
    expect(container.textContent).toContain("Hosts (IPv4 / hostname)")
  })

  it("switches to the raw BPF input when the toggle is clicked", async () => {
    const user = userEvent.setup()
    const { container } = render(<RowHarness initial={defaultFor("pcap")} />)
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Switch to raw BPF"),
    )! as HTMLButtonElement
    expect(toggle).not.toBeUndefined()
    await user.click(toggle)
    // Raw BPF textarea shows the current filter.
    expect(container.textContent).toContain("pcap-filter(7)")
    // The placeholder input has the current BPF value as its value.
    const rawInput = container.querySelector('input[placeholder="Raw libpcap filter expression"]') as HTMLInputElement
    expect(rawInput).not.toBeNull()
    expect(rawInput.value).toContain("tcp port 8080")
  })

  it("warns when a raw BPF expression uses features beyond ports + hosts", async () => {
    const user = userEvent.setup()
    const { container } = render(<RowHarness initial={defaultFor("pcap")} />)
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Switch to raw BPF"),
    )! as HTMLButtonElement
    await user.click(toggle)
    const rawInput = container.querySelector('input[placeholder="Raw libpcap filter expression"]') as HTMLInputElement
    expect(rawInput).not.toBeNull()
    // Type an expression the structured editor can't represent (vlan).
    await user.clear(rawInput)
    await user.type(rawInput, "vlan 100")
    // The "features beyond ports + hosts" warning renders.
    expect(container.textContent).toContain("features beyond ports + hosts")
  })

  it("offers the 'back to ports/hosts editor' link for a structured-parseable raw BPF", async () => {
    const user = userEvent.setup()
    const { container } = render(<RowHarness initial={defaultFor("pcap")} />)
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Switch to raw BPF"),
    )! as HTMLButtonElement
    await user.click(toggle)
    // The default BPF (tcp port ...) IS structured-parseable → the back link shows.
    expect(container.textContent).toContain("back to ports/hosts")
  })

  it("opens the Advanced disclosure to reveal the snaplen field", async () => {
    const user = userEvent.setup()
    const { container } = render(<RowHarness initial={defaultFor("pcap")} />)
    const advanced = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Advanced",
    )! as HTMLButtonElement
    expect(advanced).not.toBeUndefined()
    await user.click(advanced)
    expect(container.textContent).toContain("Snaplen (bytes)")
    // The default snaplen is shown.
    const snapInput = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(snapInput.value).toBe("262144")
  })

  it("shows the recommended interface group with 'any', 'lo', and real NICs", () => {
    const { container } = render(<RowHarness initial={defaultFor("pcap")} />)
    // The Recommended optgroup should contain 'any', 'eth0', 'lo' — the
    // virtual 'veth0' is in a separate 'Virtual' group.
    const recommended = container.querySelector("optgroup[label='Recommended']")
    expect(recommended).not.toBeNull()
    expect(recommended!.textContent).toContain("any")
    expect(recommended!.textContent).toContain("eth0")
    expect(recommended!.textContent).toContain("lo")
    // 'veth0' is in the virtual group.
    const virtual = container.querySelector("optgroup[label^='Virtual']")
    expect(virtual).not.toBeNull()
    expect(virtual!.textContent).toContain("veth0")
  })

  it("renders the 'current — not in list' fallback when the active interface is not enumerated", () => {
    const notInList: CaptureSource =
      // type-narrow to pcap source, with a non-enumerated interface.
      defaultFor("pcap").type === "pcap"
        ? { ...defaultFor("pcap"), interface: "missing0" } as Extract<CaptureSource, { type: "pcap" }>
        : defaultFor("pcap")
    const { container } = render(<RowHarness initial={notInList} />)
    expect(container.textContent).toContain("missing0 (current — not in list)")
  })

  it("updates the BPF when a port is added via the structured ChipInput", async () => {
    const user = userEvent.setup()
    let captured: CaptureSource | null = null
    // Start with a pcap source whose BPF is empty so the structured
    // editor renders NO port chips → the ports ChipInput's inner input
    // shows its "e.g. 4210, 4271 …" placeholder (which the ChipInput
    // suppresses once any chip is present).
    const emptyBpf: CaptureSource = defaultFor("pcap").type === "pcap"
      ? { ...defaultFor("pcap"), bpf_filter: null }
      : defaultFor("pcap")
    const Wrapper = () => {
      const [source, setSource] = React.useState<CaptureSource>(emptyBpf)
      return (
        <SourceEditorRow
          source={source}
          interfaces={INTERFACES}
          onChange={(next) => {
            setSource(next)
            captured = next
          }}
          onRemove={() => {}}
        />
      )
    }
    const { container } = render(<Wrapper />)
    // The Ports ChipInput's inner input has the placeholder
    // "e.g. 4210, 4271 — press Enter or comma".
    const portInput = container.querySelector(
      'input[placeholder*="4210"]',
    ) as HTMLInputElement
    expect(portInput).not.toBeNull()
    await user.type(portInput, "4210{Enter}")
    expect(captured).not.toBeNull()
    if (captured && captured.type === "pcap") {
      expect(captured.bpf_filter).toContain("tcp port 4210")
    }
  })
})

describe("CloudProbeForm (via SourceEditorRow)", () => {
  it("strips and re-applies the tcp:// prefix on the endpoint input", async () => {
    const user = userEvent.setup()
    let captured: CaptureSource | null = null
    const Wrapper = () => {
      const [source, setSource] = React.useState<CaptureSource>(defaultFor("cloud-probe"))
      return (
        <SourceEditorRow
          source={source}
          interfaces={INTERFACES}
          onChange={(next) => {
            setSource(next)
            captured = next
          }}
          onRemove={() => {}}
        />
      )
    }
    const { container } = render(<Wrapper />)
    // The friendly endpoint input is the one with placeholder "0.0.0.0:5555".
    const epInput = container.querySelector('input[placeholder="0.0.0.0:5555"]') as HTMLInputElement
    expect(epInput).not.toBeNull()
    // The default endpoint is `tcp://0.0.0.0:5555`; the input shows the
    // prefix-stripped form.
    expect(epInput.value).toBe("0.0.0.0:5555")
    await user.clear(epInput)
    await user.type(epInput, "1.2.3.4:9999")
    expect(captured).not.toBeNull()
    if (captured && captured.type === "cloud-probe") {
      expect(captured.endpoint).toBe("tcp://1.2.3.4:9999")
    }
  })

  it("sets an empty endpoint when the friendly input is cleared", async () => {
    const user = userEvent.setup()
    let captured: CaptureSource | null = null
    const Wrapper = () => {
      const [source, setSource] = React.useState<CaptureSource>(defaultFor("cloud-probe"))
      return (
        <SourceEditorRow
          source={source}
          interfaces={INTERFACES}
          onChange={(next) => {
            setSource(next)
            captured = next
          }}
          onRemove={() => {}}
        />
      )
    }
    const { container } = render(<Wrapper />)
    const epInput = container.querySelector('input[placeholder="0.0.0.0:5555"]') as HTMLInputElement
    await user.clear(epInput)
    // Trigger a change event so the onChange fires.
    await user.type(epInput, " ")
    if (captured && captured.type === "cloud-probe") {
      // The friendly value " " trims to "" → endpoint becomes "" (empty
      // branch of updateEndpoint).
      expect(captured.endpoint).toBe("")
    }
  })

  it("opens the Advanced disclosure to reveal the recv_hwm field", async () => {
    const user = userEvent.setup()
    const { container } = render(<RowHarness initial={defaultFor("cloud-probe")} />)
    const advanced = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Advanced",
    )! as HTMLButtonElement
    await user.click(advanced)
    expect(container.textContent).toContain("Receive queue depth")
    const hwmInput = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(hwmInput.value).toBe("1000")
  })
})

describe("PcapFileForm (via SourceEditorRow)", () => {
  it("renders the file path input with the current path", () => {
    const file = defaultFor("pcap-file").type === "pcap-file"
      ? { ...defaultFor("pcap-file"), path: "/tmp/foo.pcap" }
      : defaultFor("pcap-file")
    const { container } = render(<RowHarness initial={file} />)
    expect(container.textContent).toContain("File path")
    const pathInput = container.querySelector('input[placeholder="/path/to/capture.pcap"]') as HTMLInputElement
    expect(pathInput).not.toBeNull()
    expect(pathInput.value).toBe("/tmp/foo.pcap")
  })

  it("updates the path when the input changes", async () => {
    const user = userEvent.setup()
    let captured: CaptureSource | null = null
    const Wrapper = () => {
      const [source, setSource] = React.useState<CaptureSource>(defaultFor("pcap-file"))
      return (
        <SourceEditorRow
          source={source}
          interfaces={INTERFACES}
          onChange={(next) => {
            setSource(next)
            captured = next
          }}
          onRemove={() => {}}
        />
      )
    }
    const { container } = render(<Wrapper />)
    const pathInput = container.querySelector('input[placeholder="/path/to/capture.pcap"]') as HTMLInputElement
    await user.clear(pathInput)
    await user.type(pathInput, "/var/lib/heron/x.pcap")
    if (captured && captured.type === "pcap-file") {
      expect(captured.path).toContain("/var/lib/heron/x.pcap")
    }
  })

  it("toggles the realtime flag", async () => {
    const user = userEvent.setup()
    let captured: CaptureSource | null = null
    const Wrapper = () => {
      const [source, setSource] = React.useState<CaptureSource>(defaultFor("pcap-file"))
      return (
        <SourceEditorRow
          source={source}
          interfaces={INTERFACES}
          onChange={(next) => {
            setSource(next)
            captured = next
          }}
          onRemove={() => {}}
        />
      )
    }
    const { container } = render(<Wrapper />)
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(false)
    await user.click(checkbox)
    if (captured && captured.type === "pcap-file") {
      expect(captured.realtime).toBe(true)
    }
  })
})

describe("EbpfForm (via SourceEditorRow)", () => {
  it("renders the TLS libraries input with auto-discover placeholder", () => {
    const { container } = render(<RowHarness initial={defaultFor("ebpf")} />)
    expect(container.textContent).toContain("TLS libraries")
    expect(container.textContent).toContain("SSL_read")
    expect(container.textContent).toContain("SSL_write")
    const input = container.querySelector('input[placeholder="auto-discover (leave empty)"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe("")
  })

  it("opens the Advanced disclosure to reveal PID allowlist + segment size", async () => {
    const user = userEvent.setup()
    const { container } = render(<RowHarness initial={defaultFor("ebpf")} />)
    const advanced = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Advanced",
    )! as HTMLButtonElement
    await user.click(advanced)
    expect(container.textContent).toContain("PID allowlist")
    expect(container.textContent).toContain("Segment size")
    const segInput = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(segInput.value).toBe("16384")
  })

  it("updates the ssl_libs as a comma-separated list when typed", () => {
    let captured: CaptureSource | null = null
    const Wrapper = () => {
      const [source, setSource] = React.useState<CaptureSource>(defaultFor("ebpf"))
      return (
        <SourceEditorRow
          source={source}
          interfaces={INTERFACES}
          onChange={(next) => {
            setSource(next)
            captured = next
          }}
          onRemove={() => {}}
        />
      )
    }
    const { container } = render(<Wrapper />)
    const sslInput = container.querySelector(
      'input[placeholder="auto-discover (leave empty)"]',
    ) as HTMLInputElement
    // Use fireEvent.change to set the entire value at once — user.type
    // types char-by-char and the comma-split strips the separator on each
    // keystroke, defeating the test.
    fireEvent.change(sslInput, {
      target: { value: "/usr/lib/libssl.so, /opt/lib/libssl.so" },
    })
    if (captured && captured.type === "ebpf") {
      expect(captured.ssl_libs).toContain("/usr/lib/libssl.so")
      expect(captured.ssl_libs).toContain("/opt/lib/libssl.so")
    }
  })

  it("renders the static-targets summary when targets are present", async () => {
    const user = userEvent.setup()
    const withTargets = defaultFor("ebpf").type === "ebpf"
      ? {
          ...defaultFor("ebpf"),
          targets: [
            {
              binary: "/usr/local/bin/bun",
              flavor: "bun",
              write_sig: null,
              read_sig: null,
              write_offset: null,
              read_offset: null,
            },
          ],
        }
      : defaultFor("ebpf")
    const { container } = render(<RowHarness initial={withTargets} />)
    // Open the Advanced disclosure — the static-targets Field lives inside.
    const advanced = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Advanced",
    ) as HTMLButtonElement
    expect(advanced).not.toBeUndefined()
    await user.click(advanced)
    expect(container.textContent).toContain("Static targets")
    expect(container.textContent).toContain("1 configured")
  })
})
