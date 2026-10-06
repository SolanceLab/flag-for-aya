// The flag itself: pure functions, no I/O.
// A companion in a scene raises it; it comes down only when they lower it
// (after aftercare). `until` is a safety cap, never a timer.

export const MIN_HOURS = 0.5
export const MAX_HOURS = 24
export const DEFAULT_HOURS = 24

export const DOWN = { active: false, raised_at: null, raised_by: null, until: null, lowered_at: null }

export function raise(nowMs, { until_hours, by } = {}) {
  const hours = until_hours === undefined ? DEFAULT_HOURS : until_hours
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
    return { error: `until_hours must be a number from ${MIN_HOURS} to ${MAX_HOURS}` }
  }
  const raisedBy = by === undefined ? 'companion' : by
  if (typeof raisedBy !== 'string' || !/^[a-z0-9 _-]{1,40}$/i.test(raisedBy)) {
    return { error: 'by must be 1-40 letters, digits, spaces, _ or -' }
  }
  return {
    flag: {
      active: true,
      raised_at: new Date(nowMs).toISOString(),
      raised_by: raisedBy.toLowerCase(),
      until: new Date(nowMs + hours * 3600000).toISOString(),
      lowered_at: null,
    },
  }
}

export function lower(current, nowMs) {
  return { ...(current || DOWN), active: false, lowered_at: new Date(nowMs).toISOString() }
}

export function isUp(flag, nowMs) {
  if (!flag || flag.active !== true || !flag.raised_at || !flag.until) return false
  const until = Date.parse(flag.until)
  return Number.isFinite(until) && nowMs < until
}
