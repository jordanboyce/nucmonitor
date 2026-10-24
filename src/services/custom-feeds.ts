/**
 * Viewer-defined custom panels and the RSS/Atom sources that feed them.
 *
 * Everything lives in this browser's localStorage (and in Settings export),
 * never on a server. Panel ids reuse the `cw-` dynamic-panel prefix, which the
 * layout, tab snapshots and variant resets already treat as runtime panels.
 * Feeds are fetched through `/api/rss-proxy?custom=1`, which admits any public
 * host and relays only feed documents (api/_public-feed-host.js).
 */
import { loadFromStorage, saveToStorage } from '@/utils';
import { fetchWithProxy } from '@/utils/proxy';
import { effectivePubDateMs, parseFeedDate } from './feed-date';
import type { NewsItem } from '@/types';

export const CUSTOM_FEED_PANELS_STORAGE_KEY = 'nucmonitor-custom-feed-panels';
export const CUSTOM_FEED_PANEL_PREFIX = 'cw-feed-';
export const CUSTOM_FEEDS_CHANGED_EVENT = 'nucmonitor:custom-feeds-changed';

export const MAX_CUSTOM_PANELS = 12;
export const MAX_SOURCES_PER_PANEL = 10;
const MAX_TITLE_LENGTH = 60;
const MAX_NAME_LENGTH = 60;
const MAX_URL_LENGTH = 2048;
export const CUSTOM_FEED_ITEMS_PER_SOURCE = 10;
export const CUSTOM_FEED_ITEMS_PER_PANEL = 30;

export interface CustomFeedSource {
  id: string;
  name: string;
  url: string;
}

export interface CustomFeedPanelSpec {
  id: string;
  title: string;
  sources: CustomFeedSource[];
  createdAt: number;
}

export class CustomFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomFeedError';
  }
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Normalize what a viewer typed into a fetchable feed URL, or explain why not.
 * Adds `https://` when no scheme is given. Mirrors the server's custom-mode
 * policy closely enough to reject obvious mistakes before a round trip; the
 * proxy remains the authority.
 */
export function normalizeFeedUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new CustomFeedError('Enter a feed URL.');
  if (raw.length > MAX_URL_LENGTH) throw new CustomFeedError('That URL is too long.');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CustomFeedError('That is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CustomFeedError('Feed URLs must start with http:// or https://.');
  }
  if (url.username || url.password) throw new CustomFeedError('Feed URLs cannot contain a username or password.');
  if (url.port) throw new CustomFeedError('Feed URLs cannot use a custom port.');
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.includes(':') || /^\d+$/.test(host.split('.').pop() ?? '')) {
    throw new CustomFeedError('Use the feed’s public domain name, not an IP address or local host.');
  }
  url.hash = '';
  return url.toString();
}

function sanitizeSource(value: unknown): CustomFeedSource | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 32);
  const name = cleanText(record.name, MAX_NAME_LENGTH);
  if (!id || !name || typeof record.url !== 'string') return null;
  try {
    return { id, name, url: normalizeFeedUrl(record.url) };
  } catch {
    return null;
  }
}

function sanitizePanel(value: unknown): CustomFeedPanelSpec | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id.startsWith(CUSTOM_FEED_PANEL_PREFIX) || !/^[a-z0-9-]{1,48}$/.test(id)) return null;
  const title = cleanText(record.title, MAX_TITLE_LENGTH);
  if (!title) return null;
  const sources = (Array.isArray(record.sources) ? record.sources : [])
    .map(sanitizeSource)
    .filter((s): s is CustomFeedSource => s !== null)
    .slice(0, MAX_SOURCES_PER_PANEL);
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0;
  return { id, title, sources, createdAt };
}

/** Stored custom panels, oldest first. Malformed entries are dropped. */
export function loadCustomFeedPanels(): CustomFeedPanelSpec[] {
  const stored = loadFromStorage<unknown>(CUSTOM_FEED_PANELS_STORAGE_KEY, []);
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const panels: CustomFeedPanelSpec[] = [];
  for (const entry of stored) {
    const panel = sanitizePanel(entry);
    if (!panel || seen.has(panel.id)) continue;
    seen.add(panel.id);
    panels.push(panel);
    if (panels.length >= MAX_CUSTOM_PANELS) break;
  }
  return panels;
}

export function getCustomFeedPanel(id: string): CustomFeedPanelSpec | undefined {
  return loadCustomFeedPanels().find((panel) => panel.id === id);
}

export function isCustomFeedPanelId(id: string): boolean {
  return id.startsWith(CUSTOM_FEED_PANEL_PREFIX);
}

function persist(panels: CustomFeedPanelSpec[]): void {
  if (!saveToStorage(CUSTOM_FEED_PANELS_STORAGE_KEY, panels)) {
    throw new CustomFeedError('Could not save: browser storage is full or unavailable.');
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CUSTOM_FEEDS_CHANGED_EVENT));
  }
}

function update(mutator: (panels: CustomFeedPanelSpec[]) => void): CustomFeedPanelSpec[] {
  const panels = loadCustomFeedPanels();
  mutator(panels);
  persist(panels);
  return panels;
}

function requirePanel(panels: CustomFeedPanelSpec[], id: string): CustomFeedPanelSpec {
  const panel = panels.find((p) => p.id === id);
  if (!panel) throw new CustomFeedError('That panel no longer exists.');
  return panel;
}

export function createCustomFeedPanel(title: string): CustomFeedPanelSpec {
  const clean = cleanText(title, MAX_TITLE_LENGTH);
  if (!clean) throw new CustomFeedError('Give the panel a name.');
  let created: CustomFeedPanelSpec | null = null;
  update((panels) => {
    if (panels.length >= MAX_CUSTOM_PANELS) {
      throw new CustomFeedError(`You can have up to ${MAX_CUSTOM_PANELS} custom panels.`);
    }
    created = { id: `${CUSTOM_FEED_PANEL_PREFIX}${randomId()}`, title: clean, sources: [], createdAt: Date.now() };
    panels.push(created);
  });
  return created!;
}

export function renameCustomFeedPanel(id: string, title: string): void {
  const clean = cleanText(title, MAX_TITLE_LENGTH);
  if (!clean) throw new CustomFeedError('Give the panel a name.');
  update((panels) => {
    requirePanel(panels, id).title = clean;
  });
}

export function deleteCustomFeedPanel(id: string): void {
  update((panels) => {
    const index = panels.findIndex((p) => p.id === id);
    if (index !== -1) panels.splice(index, 1);
  });
}

export function addCustomFeedSource(panelId: string, source: { name: string; url: string }): CustomFeedSource {
  const url = normalizeFeedUrl(source.url);
  const name = cleanText(source.name, MAX_NAME_LENGTH) || new URL(url).hostname.replace(/^www\./, '');
  let added: CustomFeedSource | null = null;
  update((panels) => {
    const panel = requirePanel(panels, panelId);
    if (panel.sources.length >= MAX_SOURCES_PER_PANEL) {
      throw new CustomFeedError(`A panel can have up to ${MAX_SOURCES_PER_PANEL} sources.`);
    }
    if (panel.sources.some((s) => s.url === url)) {
      throw new CustomFeedError('That feed is already in this panel.');
    }
    added = { id: randomId(), name, url };
    panel.sources.push(added);
  });
  return added!;
}

export function removeCustomFeedSource(panelId: string, sourceId: string): void {
  update((panels) => {
    const panel = requirePanel(panels, panelId);
    panel.sources = panel.sources.filter((s) => s.id !== sourceId);
  });
}

/** Subscribe to changes from this tab and from other tabs. Returns an unsubscribe. */
export function onCustomFeedPanelsChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_FEED_PANELS_STORAGE_KEY) listener();
  };
  window.addEventListener(CUSTOM_FEEDS_CHANGED_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CUSTOM_FEEDS_CHANGED_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function customFeedProxyUrl(feedUrl: string): string {
  return `/api/rss-proxy?custom=1&url=${encodeURIComponent(feedUrl)}`;
}

export interface ParsedCustomFeed {
  title: string;
  items: NewsItem[];
}

function textOf(parent: Element, selector: string): string {
  return parent.querySelector(selector)?.textContent?.trim() ?? '';
}

/** Parse an RSS 2.0, RSS 1.0 (RDF) or Atom document. Throws CustomFeedError when it is none of those. */
export function parseCustomFeed(xml: string, sourceName: string, limit = CUSTOM_FEED_ITEMS_PER_SOURCE): ParsedCustomFeed {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new CustomFeedError('The feed could not be read as XML.');
  const root = doc.documentElement;
  const rootName = root?.localName?.toLowerCase();
  if (rootName !== 'rss' && rootName !== 'feed' && rootName !== 'rdf') {
    throw new CustomFeedError('That address is not an RSS or Atom feed.');
  }
  const isAtom = rootName === 'feed';
  const channelTitle = isAtom
    ? Array.from(root.children).find((el) => el.localName === 'title')?.textContent?.trim() ?? ''
    : textOf(root, 'channel > title') || textOf(root, 'title');
  const entries = Array.from(doc.getElementsByTagName(isAtom ? 'entry' : 'item')).slice(0, limit);
  const items: NewsItem[] = entries.map((entry) => {
    let link = '';
    if (isAtom) {
      const links = Array.from(entry.getElementsByTagName('link'));
      const alternate = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate') ?? links[0];
      link = alternate?.getAttribute('href') ?? '';
    } else {
      link = textOf(entry, 'link') || entry.getAttribute('rdf:about') || '';
    }
    const dateText = isAtom
      ? textOf(entry, 'published') || textOf(entry, 'updated')
      : textOf(entry, 'pubDate') || entry.getElementsByTagName('dc:date')[0]?.textContent || '';
    const { date, missing } = parseFeedDate(dateText);
    return {
      source: sourceName,
      title: textOf(entry, 'title') || '(untitled)',
      link: link.trim(),
      pubDate: date,
      pubDateMissing: missing,
      isAlert: false,
    };
  });
  return { title: channelTitle, items };
}

async function fetchFeedXml(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchWithProxy(customFeedProxyUrl(url), signal ? { signal } : {});
  if (!response.ok) {
    let message = '';
    try {
      const body = await response.clone().json() as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch { /* non-JSON error body */ }
    // A JSON `error` is the proxy's own refusal; anything else is the
    // upstream site's status passed through.
    if (response.status === 422) throw new CustomFeedError('That address is not an RSS or Atom feed.');
    if (response.status === 504) throw new CustomFeedError('The feed took too long to respond.');
    if (message === 'Host not allowed for custom feeds') {
      throw new CustomFeedError('That host is not allowed. Use a public domain name on the standard port.');
    }
    if (message) throw new CustomFeedError(`${message} (HTTP ${response.status}).`);
    throw new CustomFeedError(`The feed's site answered HTTP ${response.status}. It may block automated readers.`);
  }
  return response.text();
}

/** Fetch a feed once to check it works before saving. Resolves with its title and item count. */
export async function previewCustomFeed(input: string, signal?: AbortSignal): Promise<{ url: string; title: string; itemCount: number }> {
  const url = normalizeFeedUrl(input);
  const parsed = parseCustomFeed(await fetchFeedXml(url, signal), '', CUSTOM_FEED_ITEMS_PER_SOURCE);
  if (parsed.items.length === 0) throw new CustomFeedError('The feed was read, but it has no items yet.');
  return { url, title: parsed.title, itemCount: parsed.items.length };
}

export interface CustomFeedPanelResult {
  items: NewsItem[];
  failed: CustomFeedSource[];
}

/** Fetch every source of a panel and merge the items newest first. */
export async function fetchCustomFeedPanelItems(spec: CustomFeedPanelSpec, signal?: AbortSignal): Promise<CustomFeedPanelResult> {
  const results = await Promise.allSettled(spec.sources.map(async (source) =>
    parseCustomFeed(await fetchFeedXml(source.url, signal), source.name).items,
  ));
  const failed: CustomFeedSource[] = [];
  const items: NewsItem[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') items.push(...result.value);
    else failed.push(spec.sources[index]!);
  });
  // Undated items rank as 0 and sink below every dated one.
  items.sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a));
  return { items: items.slice(0, CUSTOM_FEED_ITEMS_PER_PANEL), failed };
}
