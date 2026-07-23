import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { setWindowOrigin } from "../../test/mocks"
import { renderPage } from "../../test/fixtures"
import { DebugIndexPage } from "./debug-index"

beforeAll(() => setWindowOrigin("http://localhost:8080/"))

describe("DebugIndexPage", () => {
  afterEach(() => {
    // No fetch stubs to restore.
  })

  it("renders the page title and description", async () => {
    const { findByText } = renderPage(<DebugIndexPage />, {
      initialEntries: ["/debug"],
    })
    expect(await findByText("Debug")).toBeInTheDocument()
    expect(await findByText(/Developer-only diagnostic pages/)).toBeInTheDocument()
  })

  it("renders links to Pipeline Health and Runtime Config sub-pages", async () => {
    const { findByText } = renderPage(<DebugIndexPage />, {
      initialEntries: ["/debug"],
    })
    expect(await findByText("Pipeline Health")).toBeInTheDocument()
    expect(await findByText("Runtime Config")).toBeInTheDocument()
    expect(await findByText("/debug/pipeline-health")).toBeInTheDocument()
    expect(await findByText("/debug/config")).toBeInTheDocument()
  })
})
