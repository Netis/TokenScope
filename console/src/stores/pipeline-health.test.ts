import { afterEach, describe, expect, it } from "bun:test"
import { resetStore } from "../../test/mocks"
import { usePipelineHealthStore } from "./pipeline-health"

const INITIAL = {
  intervalMs: 2000,
  selectedPipeline: null,
  tableGroupFilter: "all",
  tableOnlyWarn: false,
}

afterEach(() => resetStore(usePipelineHealthStore, INITIAL))

describe("usePipelineHealthStore", () => {
  it("starts with the documented defaults", () => {
    const s = usePipelineHealthStore.getState()
    expect(s.intervalMs).toBe(2000)
    expect(s.selectedPipeline).toBeNull()
    expect(s.tableGroupFilter).toBe("all")
    expect(s.tableOnlyWarn).toBe(false)
  })

  it("setIntervalMs sets a number or null (null = paused)", () => {
    usePipelineHealthStore.getState().setIntervalMs(5000)
    expect(usePipelineHealthStore.getState().intervalMs).toBe(5000)
    usePipelineHealthStore.getState().setIntervalMs(null)
    expect(usePipelineHealthStore.getState().intervalMs).toBeNull()
  })

  it("setSelectedPipeline sets / clears the selection", () => {
    usePipelineHealthStore.getState().setSelectedPipeline("capture")
    expect(usePipelineHealthStore.getState().selectedPipeline).toBe("capture")
    usePipelineHealthStore.getState().setSelectedPipeline(null)
    expect(usePipelineHealthStore.getState().selectedPipeline).toBeNull()
  })

  it("setTableGroupFilter updates the chip filter", () => {
    usePipelineHealthStore.getState().setTableGroupFilter("errors")
    expect(usePipelineHealthStore.getState().tableGroupFilter).toBe("errors")
  })

  it("setTableOnlyWarn toggles the warn-only flag", () => {
    usePipelineHealthStore.getState().setTableOnlyWarn(true)
    expect(usePipelineHealthStore.getState().tableOnlyWarn).toBe(true)
    usePipelineHealthStore.getState().setTableOnlyWarn(false)
    expect(usePipelineHealthStore.getState().tableOnlyWarn).toBe(false)
  })
})
