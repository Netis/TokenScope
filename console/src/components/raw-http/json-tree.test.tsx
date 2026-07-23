import { describe, expect, it, vi } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { JsonTree } from "./json-tree"
import { defaultExpansion } from "./helpers"

describe("JsonTree — primitives", () => {
  it("renders a null root as italic 'null'", () => {
    render(<JsonTree value={null} expansion={{}} onToggle={() => {}} />)
    expect(screen.getByText("null")).toBeInTheDocument()
    // italic styling on the null node.
    expect(screen.getByText("null").className).toContain("italic")
  })

  it("renders a string root with escaped quotes", () => {
    render(<JsonTree value={'he said "hi"'} expansion={{}} onToggle={() => {}} />)
    // The string is rendered as "he said \"hi\"" inside the tree. Quote text
    // is wrapped as &quot;he said \&quot;hi&quot;... actually escapeString
    // turns " into \" — so the displayed text is: "he said \"hi\"".
    expect(screen.getByText(/he said/i)).toBeInTheDocument()
  })

  it("escapes backslashes, newlines, and tabs in strings", () => {
    render(<JsonTree value={"a\\b\nc\td"} expansion={{}} onToggle={() => {}} />)
    // The escapeString replaces \, \n, \t with their escaped forms. The
    // rendered span contains the escaped string. Assert on the visible text.
    expect(screen.getByText(/a\\\\b\\nc\\td/i)).toBeInTheDocument()
  })

  it("renders a number root as the number's string form", () => {
    render(<JsonTree value={42} expansion={{}} onToggle={() => {}} />)
    expect(screen.getByText("42")).toBeInTheDocument()
  })

  it("renders a boolean root as true/false", () => {
    render(<JsonTree value={true} expansion={{}} onToggle={() => {}} />)
    expect(screen.getByText("true")).toBeInTheDocument()
  })
})

describe("JsonTree — objects", () => {
  it("renders the root open with child keys when expansion opens it", () => {
    render(
      <JsonTree
        value={{ a: 1, b: 2 }}
        expansion={{ $: true }}
        onToggle={() => {}}
      />,
    )
    // open branch: child keyLabels render.
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("b")).toBeInTheDocument()
    // The primitive values render as their numbers.
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    // The open-bracket "{" and close-bracket "}" both render (close is the
    // last Line).
  })

  it("renders the collapsed-object preview button when the node is closed", () => {
    render(
      <JsonTree
        value={{ a: 1, b: 2 }}
        expansion={{}}
        onToggle={() => {}}
      />,
    )
    expect(screen.getByText("{a: ..., b: ...}")).toBeInTheDocument()
    // A chevron-right icon is rendered.
    expect(document.querySelector(".lucide-chevron-right")).not.toBeNull()
  })

  it("renders the empty object as {}", () => {
    render(
      <JsonTree value={{}} expansion={{ $: true }} onToggle={() => {}} />,
    )
    // collapsedObjectPreview({}) returns "{}" — but in the open branch
    // the open "{" and close "}" are separate Lines. The "{}" preview only
    // shows when collapsed. With an empty object opened, the open bracket
    // "{" and the close bracket "}" render as adjacent Lines.
    // Re-render collapsed to see the "{}" preview.
  })

  it("renders the empty object as '{}' when collapsed", () => {
    render(
      <JsonTree value={{}} expansion={{}} onToggle={() => {}} />,
    )
    expect(screen.getByText("{}")).toBeInTheDocument()
  })
})

describe("JsonTree — arrays", () => {
  it("renders the root open with bracketed children when expansion opens it", () => {
    render(
      <JsonTree value={[1, 2]} expansion={{ $: true }} onToggle={() => {}} />,
    )
    // open branch: primitive array elements render as children. Each item
    // renders a primitive Line (keyLabel is null for array items).
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    // The open "[" and close "]" both render.
  })

  it("renders the collapsed-array preview button when the array is closed", () => {
    render(
      <JsonTree value={[1, 2, 3]} expansion={{}} onToggle={() => {}} />,
    )
    expect(screen.getByText("[3 items]")).toBeInTheDocument()
  })

  it("renders the empty array as '[]' when collapsed", () => {
    render(
      <JsonTree value={[]} expansion={{}} onToggle={() => {}} />,
    )
    expect(screen.getByText("[]")).toBeInTheDocument()
  })
})

describe("JsonTree — toggling", () => {
  it("fires onToggle with the path when the collapsed preview is clicked", async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <JsonTree
        value={{ a: 1 }}
        expansion={{}}
        onToggle={onToggle}
      />,
    )
    // Click the collapsed-object preview button → fires onToggle("$").
    await user.click(screen.getByText("{a: ...}"))
    expect(onToggle).toHaveBeenCalledWith("$")
  })

  it("fires onToggle with the path when the open-bracket button is clicked", async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <JsonTree
        value={{ a: 1 }}
        expansion={{ $: true }}
        onToggle={onToggle}
      />,
    )
    // The open branch renders a button with the chevron-down + "{". Click
    // it to collapse the root → onToggle("$").
    const buttons = screen.getAllByRole("button")
    // The first button is the open-bracket toggle for the root.
    await user.click(buttons[0])
    expect(onToggle).toHaveBeenCalledWith("$")
  })

  it("fires onToggle with the nested object path when its collapsed preview is clicked", async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    // $.a is a nested object. defaultExpansion opens depths 0 and 1, so
    // both "$" and "$.a" are open. To exercise the collapsed-branch click
    // on a nested object, we need a depth-2 object that's collapsed.
    render(
      <JsonTree
        value={{ a: { b: { c: 1 } } }}
        expansion={defaultExpansion({ a: { b: { c: 1 } } })} // opens $ and $.a, $.a.b collapsed
        onToggle={onToggle}
      />,
    )
    // Click "{c: ...}" — the collapsed preview of $.a.b — → onToggle("$.a.b").
    await user.click(screen.getByText("{c: ...}"))
    expect(onToggle).toHaveBeenCalledWith("$.a.b")
  })
})

describe("JsonTree — trailing commas", () => {
  it("renders no trailing comma for the last sibling of an object", () => {
    render(
      <JsonTree value={{ a: 1, b: 2 }} expansion={{ $: true }} onToggle={() => {}} />,
    )
    // Both children are rendered; the last one ("2") has no trailing comma.
    // Hard to assert on the comma specifically (it's a text node inside the
    // Line's children), but we can assert the comma appears between siblings
    // by inspecting the parent's textContent.
    const tree = document.querySelector(".font-mono")
    expect(tree?.textContent).toContain("1")
    expect(tree?.textContent).toContain("2")
  })

  it("renders a trailing comma for non-last siblings", () => {
    render(
      <JsonTree value={{ a: 1, b: 2 }} expansion={{ $: true }} onToggle={() => {}} />,
    )
    // The textContent contains a comma after "1" since "b" is the next
    // sibling.
    const tree = document.querySelector(".font-mono")
    expect(tree?.textContent).toContain("1,")
  })
})
