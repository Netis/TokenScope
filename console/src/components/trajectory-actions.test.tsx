import { beforeAll, describe, expect, it } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  BatchExportButton,
  DownloadTrajectoryButton,
} from "./trajectory-actions"
import { jsonResponse, mockFetch, setWindowOrigin } from "../../test/mocks"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("DownloadTrajectoryButton", () => {
  it("renders a button with the title/aria-label", () => {
    render(<DownloadTrajectoryButton url="/x" fallbackName="t.jsonl" />)
    expect(screen.getByRole("button", { name: /Download as an SFT trajectory/i })).toBeInTheDocument()
  })

  it("uses a custom title when provided", () => {
    render(
      <DownloadTrajectoryButton
        url="/x"
        fallbackName="t.jsonl"
        title="Download this turn as an SFT trajectory (.jsonl)"
      />,
    )
    expect(
      screen.getByRole("button", {
        name: /Download this turn as an SFT trajectory/i,
      }),
    ).toBeInTheDocument()
  })

  it("fires the fetch on click and downloads the file", async () => {
    const user = userEvent.setup()
    let fetched = 0
    mockFetch(() => {
      fetched++
      // Match the trajectory endpoint URL — but the test stub is keyed
      // by URL substring; here we always return a small NDJSON body.
      return new Response("line1\nline2\n", {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "content-disposition": 'attachment; filename="my.jsonl"',
        },
      })
    })
    const anchorClicks: string[] = []
    // Patch HTMLAnchorElement.prototype.click to capture the download
    // filename without actually triggering navigation. happy-dom ships
    // HTMLAnchorElement on `window` (the constructor); access via window.
    const AnchorCtor = (window as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement
    const origClick = AnchorCtor.prototype.click
    AnchorCtor.prototype.click = function (this: { download: string }) {
      anchorClicks.push(this.download)
    }
    try {
      render(<DownloadTrajectoryButton url="/api/x/y" fallbackName="fallback.jsonl" />)
      await user.click(screen.getByRole("button"))
      await waitFor(() => expect(fetched).toBe(1))
      expect(anchorClicks.length).toBe(1)
      // The download filename comes from the content-disposition header.
      expect(anchorClicks[0]).toBe("my.jsonl")
    } finally {
      AnchorCtor.prototype.click = origClick
    }
  })

  it("renders an error state when the fetch rejects", async () => {
    const user = userEvent.setup()
    mockFetch(() =>
      jsonResponse({ code: 500, message: "boom-server" }, { status: 500 }),
    )
    render(<DownloadTrajectoryButton url="/api/x" fallbackName="fallback.jsonl" />)
    await user.click(screen.getByRole("button"))
    // The error path sets the button's title to the error message and
    // adds the text-destructive class.
    expect(await screen.findByTitle(/boom-server/i)).toBeInTheDocument()
    const btn = screen.getByRole("button")
    expect(btn.className).toContain("text-destructive")
  })

  it("renders a spinner while busy and disables the button", async () => {
    const user = userEvent.setup()
    let resolve!: () => void
    mockFetch(() => new Promise<Response>((r) => {
      resolve = () => r(new Response("ok\n", { status: 200 }))
    }))
    const { container } = render(
      <DownloadTrajectoryButton url="/api/x" fallbackName="fallback.jsonl" />,
    )
    await user.click(screen.getByRole("button"))
    // The spinner svg appears (lucide-loader-2 with animate-spin). Use
    // waitFor since setBusy(true) is processed after the click promise resolves.
    await waitFor(() => expect(container.querySelector(".animate-spin")).not.toBeNull())
    expect(screen.getByRole("button")).toBeDisabled()
    // Resolve to let the component clean up.
    resolve()
    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeNull())
  })
})

describe("BatchExportButton", () => {
  it("renders a labeled button with the default label", () => {
    render(<BatchExportButton url="/x" />)
    expect(screen.getByRole("button", { name: /Export trajectories/i })).toBeInTheDocument()
  })

  it("renders a custom label when supplied", () => {
    render(<BatchExportButton url="/x" label="Export all" />)
    expect(screen.getByRole("button", { name: /Export all/i })).toBeInTheDocument()
  })

  it("shows the written/total/skipped feedback after a successful batch export", async () => {
    const user = userEvent.setup()
    mockFetch(() => {
      const headers = {
        "content-type": "application/x-ndjson",
        "x-export-written": "10",
        "x-export-total": "12",
        "x-export-skipped": "2",
      }
      return new Response("ok\n", { status: 200, headers })
    })
    render(<BatchExportButton url="/api/x" />)
    await user.click(screen.getByRole("button"))
    // The feedback line: "10/12 · 2 skipped".
    expect(await screen.findByText(/10\/12/i)).toBeInTheDocument()
    expect(screen.getByText(/2 skipped/i)).toBeInTheDocument()
  })

  it("omits the 'skipped' span when skipped is 0", async () => {
    const user = userEvent.setup()
    mockFetch(() => {
      const headers = {
        "content-type": "application/x-ndjson",
        "x-export-written": "10",
        "x-export-total": "10",
        "x-export-skipped": "0",
      }
      return new Response("ok\n", { status: 200, headers })
    })
    render(<BatchExportButton url="/api/x" />)
    await user.click(screen.getByRole("button"))
    expect(await screen.findByText(/10\/10/i)).toBeInTheDocument()
    expect(screen.queryByText(/skipped/i)).not.toBeInTheDocument()
  })

  it("renders the error text when the fetch fails", async () => {
    const user = userEvent.setup()
    mockFetch(() =>
      jsonResponse({ code: 500, message: "boom-batch" }, { status: 500 }),
    )
    render(<BatchExportButton url="/api/x" />)
    await user.click(screen.getByRole("button"))
    // The error text uses the text-destructive class.
    const errEl = await screen.findByText(/boom-batch/i)
    expect(errEl.className).toContain("text-destructive")
  })
})
