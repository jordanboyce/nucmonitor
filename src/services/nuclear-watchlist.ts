/**
 * "My sites" watchlist for the nuclear hub: a per-browser set of registry
 * facility ids, shared by the hazards and directory panels. Persisted through
 * the safe-storage helper so a disabled or null localStorage degrades to an
 * in-memory list instead of throwing.
 */

import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';
import { US_NUCLEAR_FACILITIES } from '@/config/us-nuclear-facilities';

export const NUCLEAR_WATCHLIST_STORAGE_KEY = 'nucmonitor-watchlist-v1';
export const NUCLEAR_WATCHLIST_CHANGED_EVENT = 'nucmonitor:watchlist-changed';

const KNOWN_IDS = new Set(US_NUCLEAR_FACILITIES.map((f) => f.id));
let cache: Set<string> | null = null;

/** Parse a stored value, keeping only ids that still exist in the registry. */
export function parseWatchlist(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && KNOWN_IDS.has(id)));
  } catch {
    return new Set();
  }
}

export function getNuclearWatchlist(): Set<string> {
  if (!cache) cache = parseWatchlist(safeStorageGet(NUCLEAR_WATCHLIST_STORAGE_KEY));
  return new Set(cache);
}

export function isOnNuclearWatchlist(id: string): boolean {
  return getNuclearWatchlist().has(id);
}

export function toggleNuclearWatchlist(id: string): boolean {
  const next = getNuclearWatchlist();
  const added = !next.has(id);
  if (added) next.add(id);
  else next.delete(id);
  cache = next;
  safeStorageSet(NUCLEAR_WATCHLIST_STORAGE_KEY, JSON.stringify([...next].sort()));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NUCLEAR_WATCHLIST_CHANGED_EVENT, { detail: { id, added } }));
  }
  return added;
}
