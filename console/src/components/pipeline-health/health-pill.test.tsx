import { afterEach, describe, expect, it } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { HealthPill } from "./health-pill"

// RTL auto-cleanup runs via its own afterEach import, but be explicit so
// each test starts with an empty body when screen/container is consulted.
afterEach(() => cleanup())

describe("HealthPill", () => {
  it("renders the healthy label with no icon prefix", () => {
    const { container } = render(<HealthPill level="healthy" />)
    expect(container.textContent).toContain("Healthy")
    expect(container.textContent).not.toContain("⚠")
    expect(container.textContent).not.toContain("✗")
  })

  it("renders the warning label prefixed with ⚠", () => {
    const { container } = render(<HealthPill level="warning" />)
    expect(container.textContent).toContain("Warning")
    expect(container.textContent).toContain("⚠")
  })

  it("renders the critical label prefixed with ✗", () => {
    const { container } = render(<HealthPill level="critical" />)
    expect(container.textContent).toContain("Critical")
    expect(container.textContent).toContain("✗")
  })

  it("renders a count + 'warnings' suffix for warning with a non-zero count", () => {
    const { container } = render(<HealthPill level="warning" count={3} />)
    expect(container.textContent).toContain("3 warnings")
  })

  it("renders a count + 'critical' suffix for critical with a non-zero count", () => {
    const { container } = render(<HealthPill level="critical" count={2} />)
    expect(container.textContent).toContain("2 critical")
  })

  it("falls back to the bare label for healthy even when count is given", () => {
    const { container } = render(<HealthPill level="healthy" count={5} />)
    expect(container.textContent).toContain("Healthy")
    // Healthy ignores the count — the suffix "5" should not be appended.
    expect(container.textContent).not.toContain("5")
  })

  it("falls back to the bare label when count is 0", () => {
    const { container } = render(<HealthPill level="warning" count={0} />)
    expect(container.textContent).toContain("Warning")
  })

  it("applies the healthy (emerald) palette class", () => {
    const { container } = render(<HealthPill level="healthy" />)
    const span = container.querySelector("span")!
    expect(span.className).toContain("emerald")
  })

  it("applies the warning (amber) palette class", () => {
    const { container } = render(<HealthPill level="warning" />)
    const span = container.querySelector("span")!
    expect(span.className).toContain("amber")
  })

  it("applies the critical (red) palette class", () => {
    const { container } = render(<HealthPill level="critical" />)
    const span = container.querySelector("span")!
    expect(span.className).toContain("red")
  })
})
