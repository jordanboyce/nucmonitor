import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly(
  "cleanup-expired-pairing-tokens",
  { minuteUTC: 27 },
  internal.telegramPairingTokens.cleanupExpired,
);

// Bounded recovery for account deletions whose scheduled continuation was
// dropped. Without it the by_status_updatedAt index has no reader, and a user
// whose erase stalled sits write-fenced and already anonymized while their
// subscription keeps billing, recoverable only by clicking Delete again or by
// support running the runbook. The mutation only re-arms rows already staler
// than PENDING_STALE_AFTER_MS, so a live retry backoff is never doubled, and
// re-running a step is a no-op because every stepper re-queries its leftovers.
crons.hourly(
  "account-deletion-stalled-reaper",
  { minuteUTC: 7 },
  internal.accountDeletion.batches.reapStalledDeletions,
  {},
);

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

crons.daily(
  "email-soft-bounce-prune",
  { hourUTC: 4, minuteUTC: 50 },
  internal.emailSuppressions.pruneSoftBounceData,
  {},
);

crons.daily(
  "broadcast-ramp-runner",
  { hourUTC: 13, minuteUTC: 0 },
  internal.broadcast.rampRunner.runDailyRamp,
);

// Daily prune of `wavePickedContacts` rows belonging to discarded/failed
// wave runs older than 24h. Each invocation deletes one chunk (500 rows)
// and self-schedules until a run's rows are drained, then moves on. Avoids
// hitting Convex's per-mutation write limit on bulk deletion of up to 25k
// rows in one shot. See `convex/broadcast/waveRuns.ts`
// (`cleanupDiscardedWavePickedContactsAction`).
crons.daily(
  "wave-runs-cleanup",
  { hourUTC: 4, minuteUTC: 0 },
  internal.broadcast.waveRuns.cleanupDiscardedWavePickedContactsAction,
  {},
);

// Idempotent daily seed of the `followedCountriesShards` lock table
// (Codex round-4 P0 v2). Skips existing shards; inserts any missing
// shard ids in `[0, SHARD_COUNT)`. Defends against a deploy-time seed
// step being skipped — every `followCountry` / `unfollowCountry` /
// `mergeAnonymousLocal` mutation throws SHARDS_NOT_SEEDED if its shard
// row is missing, so the cron is the steady-state self-heal. Cheap:
// post-seed it just runs a 64-row collect + skip-loop.
crons.daily(
  "followed-countries-shards-seed",
  { hourUTC: 3, minuteUTC: 0 },
  internal.followedCountries._seedShards,
);

// Daily dedupe pass for the `followedCountriesShards` table. Pairs with
// `_seedShards` above: a concurrent-seed race (e.g. the deploy step
// running in parallel with the cron tick) can produce duplicate rows
// for the same `shardId`. `readShardOrThrow` uses `.first()` so
// duplicates don't break correctness, but they degrade OCC contention
// coverage for users hashing to that shard. Running the dedupe in the
// same daily slot, 1 minute after the seed, guarantees the table is
// back to exactly SHARD_COUNT rows within 24h of any race. Idempotent
// in the steady-state (no duplicates → no deletes).
crons.daily(
  "followed-countries-shards-dedupe",
  { hourUTC: 3, minuteUTC: 1 },
  internal.followedCountries._dedupeShards,
);

crons.daily(
  "followed-countries-country-locks-seed",
  { hourUTC: 3, minuteUTC: 2 },
  internal.followedCountries._seedCountryLocks,
);

crons.daily(
  "followed-countries-country-locks-dedupe",
  { hourUTC: 3, minuteUTC: 3 },
  internal.followedCountries._dedupeCountryLocks,
);

export default crons;
