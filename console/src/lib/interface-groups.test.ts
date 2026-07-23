import { describe, expect, it } from "bun:test"
import { groupInterfaces } from "./interface-groups"
import type { CaptureInterface } from "@/types/api"

function iface(name: string, addresses: string[] = []): CaptureInterface {
  return {
    name,
    description: null,
    addresses,
    is_up: true,
    is_running: true,
    is_loopback: name === "lo",
    is_wireless: false,
  }
}

describe("groupInterfaces", () => {
  it("places 'any' and 'lo' in recommended", () => {
    const g = groupInterfaces([iface("any"), iface("lo")])
    expect(g.recommended.map((i) => i.name)).toEqual(["any", "lo"])
    expect(g.virtual).toEqual([])
  })

  it("routes virtual prefixes (veth/vnet/virbr/docker/br-/cni/…) into the virtual bucket", () => {
    const virtual = [
      iface("veth0a3b"),
      iface("vnet0"),
      iface("virbr0"),
      iface("docker0"),
      iface("br-abc123"),
      iface("cni0"),
      iface("flannel.1"),
      iface("weave"),
      iface("cali123"),
      iface("tap0"),
      iface("tun0"),
    ]
    const g = groupInterfaces(virtual)
    expect(g.virtual.map((i) => i.name).sort()).toEqual(
      [
        "br-abc123",
        "cni0",
        "cali123",
        "docker0",
        "flannel.1",
        "tap0",
        "tun0",
        "veth0a3b",
        "virbr0",
        "vnet0",
        "weave",
      ].sort(),
    )
    expect(g.recommended).toEqual([])
  })

  it("places a real-looking NIC into recommended", () => {
    const g = groupInterfaces([iface("eth0", ["10.0.0.1"])])
    expect(g.recommended.map((i) => i.name)).toEqual(["eth0"])
  })

  it("sorts recommended: 'any' first, interfaces with addresses next, then alphabetical, 'lo' last", () => {
    const g = groupInterfaces([
      iface("lo"),
      iface("eno2", []),
      iface("eno1", ["10.0.0.1"]),
      iface("any"),
      iface("eth5", ["10.0.0.5"]),
      iface("eth1", ["10.0.0.2"]),
    ])
    // any → (addressed, alphabetical) eno1, eth1, eth5 → (no addresses, alpha) eno2 → lo
    expect(g.recommended.map((i) => i.name)).toEqual([
      "any",
      "eno1",
      "eth1",
      "eth5",
      "eno2",
      "lo",
    ])
  })

  it("sorts the virtual bucket alphabetically", () => {
    const g = groupInterfaces([iface("vnet9"), iface("veth1"), iface("virbr0")])
    expect(g.virtual.map((i) => i.name)).toEqual(["veth1", "virbr0", "vnet9"])
  })

  it("returns empty buckets for an empty input", () => {
    const g = groupInterfaces([])
    expect(g.recommended).toEqual([])
    expect(g.virtual).toEqual([])
  })

  it("prefers an interface with addresses over one without, ignoring case-insensitive prefix match only for virtual names", () => {
    // 'virtnet' is NOT a virtual prefix (virbr is), so it's recommended;
    // it has an address so it sorts ahead of the address-less real NIC.
    const g = groupInterfaces([iface("virtnet", ["10.0.0.9"]), iface("eth0", [])])
    expect(g.recommended.map((i) => i.name)).toEqual(["virtnet", "eth0"])
  })
})
