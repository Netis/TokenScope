import { describe, expect, it } from "bun:test"
import {
  formatAxisTime,
  formatBytes,
  formatDateTime,
  formatDateTimeMs,
  formatDuration,
  formatMs,
  formatNumber,
  formatRelativeTime,
  formatTime,
} from "./format"

// formatAxisTime / formatTime / formatDateTime* render in the local timezone
// (via Date.getHours()/getMonth()/etc.). Tests assert the *shape* (number of
// segments, presence of date) rather than literal values, so they pass
// regardless of the runner's TZ.

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const EPOCH = 1_780_000_000 // mid-2026, arbitrary

describe("formatAxisTime", () => {
  it("renders HH:MM only when the span is under 24h", () => {
    for (const span of [15 * MINUTE, HOUR, 6 * HOUR, 23 * HOUR]) {
      const s = formatAxisTime(EPOCH, span)
      expect(s).toMatch(/^\d{2}:\d{2}$/)
    }
  })

  it("renders MM-DD HH:MM when the span is between 24h and 7d", () => {
    for (const span of [DAY, 2 * DAY, 3 * DAY, 6 * DAY]) {
      const s = formatAxisTime(EPOCH, span)
      expect(s).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    }
  })

  it("renders date-only (MM-DD) at 7d or longer", () => {
    for (const span of [7 * DAY, 14 * DAY, 30 * DAY]) {
      const s = formatAxisTime(EPOCH, span)
      expect(s).toMatch(/^\d{2}-\d{2}$/)
    }
  })

  it("falls back to HH:MM when the span is 0 (single-point data)", () => {
    expect(formatAxisTime(EPOCH, 0)).toMatch(/^\d{2}:\d{2}$/)
  })

  it("treats the 24h boundary inclusively as multi-day", () => {
    // Exactly 24h: still in the [24h, 7d) bucket → date prefix included.
    expect(formatAxisTime(EPOCH, DAY)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it("treats the 7d boundary inclusively as date-only", () => {
    expect(formatAxisTime(EPOCH, 7 * DAY)).toMatch(/^\d{2}-\d{2}$/)
  })
})

describe("formatTime", () => {
  it("renders HH:MM:SS.mmm (3-digit millis) from a ms epoch", () => {
    expect(formatTime(EPOCH * 1000)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it("zero-pads the milliseconds field", () => {
    // 1970-01-01 00:00:00.000 UTC → ms is "000" everywhere.
    expect(formatTime(0)).toMatch(/^\d{2}:\d{2}:\d{2}\.000$/)
  })
})

describe("formatDateTime / formatDateTimeMs", () => {
  it("formatDateTime renders YYYY-MM-DD HH:MM:SS", () => {
    expect(formatDateTime(EPOCH * 1000)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    )
  })

  it("formatDateTimeMs renders YYYY-MM-DD HH:MM:SS.mmm", () => {
    expect(formatDateTimeMs(EPOCH * 1000)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
    )
  })
})

describe("formatMs", () => {
  it("returns '—' for null / undefined", () => {
    expect(formatMs(null)).toBe("—")
    expect(formatMs(undefined)).toBe("—")
  })

  it("returns '<1ms' for sub-millisecond values", () => {
    expect(formatMs(0)).toBe("<1ms")
    expect(formatMs(0.4)).toBe("<1ms")
  })

  it("renders sub-second ms with one decimal", () => {
    expect(formatMs(1)).toBe("1.0ms")
    expect(formatMs(999)).toBe("999.0ms")
  })

  it("renders >=1s in seconds with two decimals", () => {
    expect(formatMs(1000)).toBe("1.00s")
    expect(formatMs(1500)).toBe("1.50s")
    expect(formatMs(12345)).toBe("12.35s")
  })
})

describe("formatDuration", () => {
  it("returns '—' for null / undefined", () => {
    expect(formatDuration(null)).toBe("—")
    expect(formatDuration(undefined)).toBe("—")
  })

  it("renders sub-second durations as raw ms", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(999)).toBe("999ms")
  })

  it("renders <60s durations as seconds with two decimals", () => {
    expect(formatDuration(1000)).toBe("1.00s")
    expect(formatDuration(59_999)).toBe("60.00s")
  })

  it("renders >=1m and <60m as '<m> <s>'", () => {
    // 1m exactly → "1m 0s"; 90s → "1m 30s"
    expect(formatDuration(60_000)).toBe("1m 0s")
    expect(formatDuration(90_000)).toBe("1m 30s")
  })

  it("renders >=60m as '<h> <m>'", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h 0m")
    expect(formatDuration(90 * 60_000)).toBe("1h 30m")
  })
})

describe("formatNumber", () => {
  it("returns '—' for null / undefined", () => {
    expect(formatNumber(null)).toBe("—")
    expect(formatNumber(undefined)).toBe("—")
  })

  it("renders small numbers verbatim", () => {
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(999)).toBe("999")
  })

  it("renders thousands with a K suffix and one decimal", () => {
    expect(formatNumber(1_000)).toBe("1.0K")
    expect(formatNumber(12_345)).toBe("12.3K")
  })

  it("renders millions with an M suffix and one decimal", () => {
    expect(formatNumber(1_000_000)).toBe("1.0M")
    expect(formatNumber(2_500_000)).toBe("2.5M")
  })
})

describe("formatBytes", () => {
  it("returns '—' for null / undefined", () => {
    expect(formatBytes(null)).toBe("—")
    expect(formatBytes(undefined)).toBe("—")
  })

  it("renders raw bytes under 1024", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  it("renders KiB for [1024, 1MiB)", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB")
    expect(formatBytes(2048)).toBe("2.0 KiB")
  })

  it("renders MiB for [1MiB, 1GiB)", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB")
  })

  it("renders GiB at 1GiB and above", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GiB")
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GiB")
  })
})

// formatRelativeTime reads Date.now() internally. Pin the clock so the
// "same day" / "yesterday" / "Nd ago" buckets are deterministic regardless of
// the runner's wall time. Each test stubs Date.now and restores it.
describe("formatRelativeTime", () => {
  const NOW_MS = 1_780_000_000_000 // mid-2026
  const DAY_MS = 86_400_000

  function stubNow(fixedMs: number): () => void {
    const orig = Date.now
    // @ts-expect-error — narrowing the global getter is intentional in tests
    Date.now = () => fixedMs
    return () => {
      Date.now = orig
    }
  }

  it('returns "HH:MM" when the timestamp is earlier today', () => {
    const restore = stubNow(NOW_MS)
    // A few hours earlier the same calendar day (same-day via toDateString).
    const earlierSameDay = NOW_MS - 3 * 60 * 60 * 1000
    expect(formatRelativeTime(earlierSameDay)).toMatch(/^\d{2}:\d{2}$/)
    restore()
  })

  it('returns "yesterday" when the timestamp is the previous calendar day', () => {
    const restore = stubNow(NOW_MS)
    // 1.5 days ago → previous calendar day in any TZ.
    const prevDay = NOW_MS - 1.5 * DAY_MS
    expect(formatRelativeTime(prevDay)).toBe("yesterday")
    restore()
  })

  it('returns "Nd ago" for >=2 days', () => {
    const restore = stubNow(NOW_MS)
    expect(formatRelativeTime(NOW_MS - 3 * DAY_MS)).toBe("3d ago")
    restore()
  })

  it("floors the day count", () => {
    const restore = stubNow(NOW_MS)
    // 10 days + a few hours → "10d ago", not rounded up.
    expect(formatRelativeTime(NOW_MS - 10 * DAY_MS - 3 * 60 * 60 * 1000)).toBe("10d ago")
    restore()
  })
})
