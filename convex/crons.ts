import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Retention sweep for the preference-write rate limiter (#6706). The limiter
// used to drop expired-window rows inline on every write, which widened that
// mutation's OCC read set from one counter row to the caller's entire row set
// and livelocked users writing from two tabs. Collecting them here keeps the
// write path's read set at exactly the current window. Hourly, not daily: a
// user writing continuously produces one row per 60s window, so an hourly tick
// bounds the table at ~60 rows per active user instead of ~1440.
crons.hourly(
  "user-prefs-rate-limit-prune",
  { minuteUTC: 52 },
  internal.userPreferences.pruneStaleWriteRateLimits,
  {},
);

export default crons;
