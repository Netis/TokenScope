import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ClaudeCliOverlay } from "./claude-cli"

// The ClaudeCliOverlay exports a `UserMessageContent` slot that segments the
// user-message text and renders scaffold artifacts (system-reminder,
// slash-command triples, local-command-stdout) as collapsible folds. This
// test exercises the React component (the existing claude-cli.test.ts covers
// the pure segmentClaudeCliUserText module).

const UserMessageContent = ClaudeCliOverlay.UserMessageContent!

describe("ClaudeCliOverlay — UserMessageContent", () => {
  it("returns null for an empty segment list (whitespace-only text trims to nothing)", () => {
    const { container } = render(<UserMessageContent text="   " />)
    // The "plain" segment is trimmed to "" and the row returns null.
    // The outer wrapping div is still rendered but has no inner content.
    expect(container.querySelector(".space-y-1")?.children.length).toBe(0)
  })

  it("renders plain text through Markdown", () => {
    render(<UserMessageContent text="hello world" />)
    expect(screen.getByText("hello world")).toBeInTheDocument()
  })

  it("renders a system-reminder fold (collapsed by default) and expands on click", async () => {
    const user = userEvent.setup()
    render(<UserMessageContent text={"<system-reminder>secret notes\nmore lines</system-reminder>"} />)
    // Header label present
    expect(screen.getByText("system-reminder")).toBeInTheDocument()
    expect(screen.getByText(/2 lines/i)).toBeInTheDocument()
    // Body collapsed by default
    expect(screen.queryByText("secret notes")).not.toBeInTheDocument()
    // Expand
    await user.click(screen.getByRole("button", { name: /system-reminder/i }))
    expect(await screen.findByText(/secret notes/)).toBeInTheDocument()
    expect(await screen.findByText(/more lines/)).toBeInTheDocument()
  })

  it("renders a single-line system-reminder with singular 'line' label", () => {
    render(<UserMessageContent text={"<system-reminder>one line</system-reminder>"} />)
    expect(screen.getByText(/1 line/i)).toBeInTheDocument()
  })

  it("renders a command fold with name + message + args and expands to reveal them", async () => {
    const user = userEvent.setup()
    render(
      <UserMessageContent
        text={"<command-name>plan</command-name><command-message>planning</command-message><command-args>--fix</command-args>"}
      />,
    )
    // Header has the slash-name
    expect(screen.getByText("/plan", { exact: false })).toBeInTheDocument()
    // message label visible in collapsed header (truncate span)
    expect(screen.getByText("planning")).toBeInTheDocument()
    // Expand
    await user.click(screen.getByRole("button", { name: /plan/i }))
    // expanded reveals "message" + "args" section labels, plus the args body.
    expect(await screen.findByText("message")).toBeInTheDocument()
    expect(await screen.findByText("args")).toBeInTheDocument()
    expect(await screen.findByText("--fix")).toBeInTheDocument()
  })

  it("renders a command fold with only name (no message / args) and no extra info", async () => {
    render(<UserMessageContent text={"<command-name>fast</command-name>"} />)
    // header renders the /name
    expect(screen.getByText("/fast", { exact: false })).toBeInTheDocument()
  })

  it("renders a local-command-stdout fold with line count and expands to reveal body", async () => {
    const user = userEvent.setup()
    render(
      <UserMessageContent
        text={"<local-command-stdout>line one\nline two\nline three</local-command-stdout>"}
      />,
    )
    expect(screen.getByText("command output")).toBeInTheDocument()
    expect(screen.getByText(/3 lines/i)).toBeInTheDocument()
    // Expand
    await user.click(screen.getByRole("button", { name: /command output/i }))
    expect(await screen.findByText(/line one/)).toBeInTheDocument()
    expect(await screen.findByText(/line two/)).toBeInTheDocument()
    expect(await screen.findByText(/line three/)).toBeInTheDocument()
  })

  it("mixes plain text + command + system-reminder + local-command-stdout", async () => {
    const user = userEvent.setup()
    const input =
      "User: hi there " +
      "<command-name>plan</command-name><command-message>m</command-message><command-args>a</command-args>" +
      " plain-after-command " +
      "<system-reminder>internal note</system-reminder>" +
      " between " +
      "<local-command-stdout>out line</local-command-stdout>" +
      " end"
    render(<UserMessageContent text={input} />)
    // Each scaffold has a fold button; plain text segments render directly.
    expect(screen.getByText("User: hi there")).toBeInTheDocument()
    expect(screen.getByText("plain-after-command")).toBeInTheDocument()
    expect(screen.getByText("between")).toBeInTheDocument()
    expect(screen.getByText("end")).toBeInTheDocument()
    // Headers for the folds
    expect(screen.getByText("system-reminder")).toBeInTheDocument()
    expect(screen.getByText("command output")).toBeInTheDocument()
    // Expand system-reminder
    await user.click(screen.getByRole("button", { name: /system-reminder/i }))
    expect(await screen.findByText("internal note")).toBeInTheDocument()
  })

  it("unclosed <system-reminder> spills remainder as plain (no fold)", () => {
    render(<UserMessageContent text={"text <system-reminder>oops no close"} />)
    // The "text " plain segment renders + the remainder (including the
    // unclosed opening tag) is appended as plain text.
    expect(screen.getByText(/text/)).toBeInTheDocument()
    expect(screen.getByText(/oops no close/)).toBeInTheDocument()
    // No fold header
    expect(screen.queryByRole("button", { name: /system-reminder/i })).not.toBeInTheDocument()
  })
})
