import { afterEach, describe, expect, it } from "bun:test"
import { resetStore } from "../../test/mocks"
import { useSidebarStore } from "./sidebar"

afterEach(() => resetStore(useSidebarStore, { expanded: false }))

describe("useSidebarStore", () => {
  it("starts collapsed", () => {
    expect(useSidebarStore.getState().expanded).toBe(false)
  })

  it("toggle flips expanded", () => {
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().expanded).toBe(true)
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().expanded).toBe(false)
  })

  it("setExpanded sets an explicit value", () => {
    useSidebarStore.getState().setExpanded(true)
    expect(useSidebarStore.getState().expanded).toBe(true)
    useSidebarStore.getState().setExpanded(false)
    expect(useSidebarStore.getState().expanded).toBe(false)
  })
})
