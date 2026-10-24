export const CURRENT_PREFS_SCHEMA_VERSION = 1;

export const MAX_PREFS_BLOB_SIZE = 65536;

// Cloud preference writes are low-latency but public to authenticated Convex
// clients. Keep the authoritative guard inside the mutation so direct
// *.convex.site callers cannot bypass the Vercel edge limiter. Keep these
// values in lockstep with api/user-prefs.ts; tests/user-prefs-rate-limit.test.mts
// guards the duplicated Edge/Convex constants from drifting. Unlike the
// Redis-backed Vercel pre-gate, this mutation-local backstop intentionally
// fails closed if its own counter storage fails: failing open here would
// reopen the direct-Convex bypass this guard exists to close.
export const USER_PREFS_WRITE_RATE_LIMIT = 30;
export const USER_PREFS_WRITE_RATE_WINDOW_MS = 60 * 1000;
