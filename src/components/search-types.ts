import type { Command } from '@/config/commands';

export type SearchResultType =
  | 'country'
  | 'news'
  | 'market'
  | 'pipeline'
  | 'cable'
  | 'datacenter'
  | 'earthquake'
  | 'outage'
  | 'nuclear'
  | 'irradiator';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle?: string;
  data: unknown;
}

export interface SearchableSource {
  type: SearchResultType;
  items: { id: string; title: string; subtitle?: string; searchText?: string; data: unknown }[];
}

export interface SearchCommandMatch {
  kind: 'command';
  command: Command;
  score: number;
  title: string;
  subtitle: string;
}

export interface SearchEntityMatch {
  kind: 'result';
  result: SearchResult;
  score: number;
}

export type SearchMatch = SearchCommandMatch | SearchEntityMatch;

export function searchMatchIdentity(match: SearchMatch): string {
  if (match.kind === 'command') return JSON.stringify(['command', match.command.id]);
  // Indexed subtitle text (prices, quake magnitudes) can update
  // without changing the logical target. Keep it out of the identity so an
  // opener can resolve and dispatch the fresh payload after a benign refresh.
  return JSON.stringify([
    'result',
    match.result.type,
    match.result.id,
    match.result.title,
  ]);
}
