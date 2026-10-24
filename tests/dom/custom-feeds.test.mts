import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/proxy', () => ({
  fetchWithProxy: vi.fn(),
}));

import { fetchWithProxy } from '@/utils/proxy';
import {
  CUSTOM_FEED_PANELS_STORAGE_KEY,
  CUSTOM_FEEDS_CHANGED_EVENT,
  CustomFeedError,
  MAX_SOURCES_PER_PANEL,
  addCustomFeedSource,
  createCustomFeedPanel,
  customFeedProxyUrl,
  deleteCustomFeedPanel,
  fetchCustomFeedPanelItems,
  isCustomFeedPanelId,
  loadCustomFeedPanels,
  normalizeFeedUrl,
  parseCustomFeed,
  previewCustomFeed,
  removeCustomFeedSource,
  renameCustomFeedPanel,
} from '@/services/custom-feeds';
import { renderCustomFeedsSettings } from '@/components/CustomFeedsSettings';

const mockedFetch = vi.mocked(fetchWithProxy);

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Reactor Blog</title>
  <item><title>Older</title><link>https://blog.example.net/older</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>
  <item><title>Newest</title><link>https://blog.example.net/newest</link><pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Source</title>
  <entry><title>Middle</title><link rel="alternate" href="https://atom.example.org/middle"/><updated>2026-10-21T08:00:00Z</updated></entry>
</feed>`;

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

describe('custom feed store', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    mockedFetch.mockReset();
  });

  it('normalizes typed URLs and rejects ones the proxy would refuse', () => {
    expect(normalizeFeedUrl(' blog.example.net/feed#top ')).toBe('https://blog.example.net/feed');
    expect(normalizeFeedUrl('http://blog.example.net/rss')).toBe('http://blog.example.net/rss');
    for (const bad of ['', 'ftp://example.com/feed', 'https://user:pw@example.com/feed', 'https://example.com:8080/feed', 'http://localhost/feed', 'http://10.0.0.1/feed', 'not a url at all']) {
      expect(() => normalizeFeedUrl(bad), bad).toThrow(CustomFeedError);
    }
  });

  it('creates, renames and deletes panels with cw-feed- ids and notifies listeners', () => {
    const listener = vi.fn();
    window.addEventListener(CUSTOM_FEEDS_CHANGED_EVENT, listener);
    const panel = createCustomFeedPanel('  Utility   news ');
    expect(panel.id).toMatch(/^cw-feed-[0-9a-f]{12}$/);
    expect(isCustomFeedPanelId(panel.id)).toBe(true);
    expect(loadCustomFeedPanels()).toEqual([expect.objectContaining({ id: panel.id, title: 'Utility news', sources: [] })]);

    renameCustomFeedPanel(panel.id, 'Grid operators');
    expect(loadCustomFeedPanels()[0]!.title).toBe('Grid operators');

    deleteCustomFeedPanel(panel.id);
    expect(loadCustomFeedPanels()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
    window.removeEventListener(CUSTOM_FEEDS_CHANGED_EVENT, listener);
  });

  it('adds and removes sources, refusing duplicates and overflow', () => {
    const panel = createCustomFeedPanel('Blogs');
    const source = addCustomFeedSource(panel.id, { name: '', url: 'blog.example.net/feed' });
    expect(source).toEqual(expect.objectContaining({ name: 'blog.example.net', url: 'https://blog.example.net/feed' }));
    expect(() => addCustomFeedSource(panel.id, { name: 'Again', url: 'https://blog.example.net/feed' })).toThrow(/already/);
    for (let i = 1; i < MAX_SOURCES_PER_PANEL; i++) {
      addCustomFeedSource(panel.id, { name: `S${i}`, url: `https://s${i}.example.net/feed` });
    }
    expect(() => addCustomFeedSource(panel.id, { name: 'One too many', url: 'https://extra.example.net/feed' })).toThrow(CustomFeedError);
    removeCustomFeedSource(panel.id, source.id);
    expect(loadCustomFeedPanels()[0]!.sources).toHaveLength(MAX_SOURCES_PER_PANEL - 1);
  });

  it('drops malformed or hostile stored entries instead of trusting them', () => {
    localStorage.setItem(CUSTOM_FEED_PANELS_STORAGE_KEY, JSON.stringify([
      { id: 'nuclear-events', title: 'Hijack a built-in panel', sources: [] },
      { id: 'cw-feed-ok', title: 'Kept', sources: [
        { id: 'a', name: 'Good', url: 'https://good.example.net/rss' },
        { id: 'b', name: 'Local', url: 'http://127.0.0.1/rss' },
        { id: 'c', name: 'Script', url: 'javascript:alert(1)' },
      ] },
      { id: 'cw-feed-ok', title: 'Duplicate id', sources: [] },
      'garbage',
    ]));
    expect(loadCustomFeedPanels()).toEqual([
      { id: 'cw-feed-ok', title: 'Kept', createdAt: 0, sources: [{ id: 'a', name: 'Good', url: 'https://good.example.net/rss' }] },
    ]);
  });
});

describe('custom feed fetching', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => mockedFetch.mockReset());

  it('parses RSS and Atom documents and rejects other XML', () => {
    const rss = parseCustomFeed(RSS, 'Blog');
    expect(rss.title).toBe('Reactor Blog');
    expect(rss.items.map((i) => [i.title, i.link, i.source])).toEqual([
      ['Older', 'https://blog.example.net/older', 'Blog'],
      ['Newest', 'https://blog.example.net/newest', 'Blog'],
    ]);
    const atom = parseCustomFeed(ATOM, 'Atom');
    expect(atom.title).toBe('Atom Source');
    expect(atom.items[0]).toEqual(expect.objectContaining({ title: 'Middle', link: 'https://atom.example.org/middle', pubDateMissing: false }));
    expect(() => parseCustomFeed('<html><body/></html>', 'x')).toThrow(/not an RSS or Atom/);
    expect(() => parseCustomFeed('<rss><unclosed></rss>', 'x')).toThrow(CustomFeedError);
  });

  it('previews through the custom proxy mode and explains proxy refusals', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(RSS));
    await expect(previewCustomFeed('blog.example.net/feed')).resolves.toEqual({
      url: 'https://blog.example.net/feed', title: 'Reactor Blog', itemCount: 2,
    });
    expect(mockedFetch).toHaveBeenCalledWith(customFeedProxyUrl('https://blog.example.net/feed'), {});
    expect(customFeedProxyUrl('https://blog.example.net/feed')).toBe('/api/rss-proxy?custom=1&url=https%3A%2F%2Fblog.example.net%2Ffeed');

    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Not an RSS or Atom feed' }), { status: 422 }));
    await expect(previewCustomFeed('https://blog.example.net/')).rejects.toThrow(/not an RSS or Atom feed/);
  });

  it('merges a panel’s sources newest first and reports the ones that failed', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      // The proxy URL carries the feed URL in its `url` parameter.
      const feedHost = new URL(new URL(url, 'http://localhost').searchParams.get('url') ?? '').hostname;
      if (feedHost === 'blog.example.net') return textResponse(RSS);
      if (feedHost === 'atom.example.org') return textResponse(ATOM);
      return textResponse('nope', 500);
    });
    const result = await fetchCustomFeedPanelItems({
      id: 'cw-feed-x', title: 'Mix', createdAt: 0, sources: [
        { id: '1', name: 'Blog', url: 'https://blog.example.net/feed' },
        { id: '2', name: 'Atom', url: 'https://atom.example.org/feed' },
        { id: '3', name: 'Broken', url: 'https://broken.example.com/feed' },
      ],
    });
    expect(result.items.map((i) => i.title)).toEqual(['Newest', 'Middle', 'Older']);
    expect(result.failed.map((s) => s.name)).toEqual(['Broken']);
  });
});

describe('Settings → Custom tab', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => mockedFetch.mockReset());

  it('checks a feed, creates a new panel named after it and lists the source', async () => {
    mockedFetch.mockResolvedValue(textResponse(RSS));
    const container = document.createElement('div');
    const settings = renderCustomFeedsSettings();
    container.innerHTML = settings.html;
    document.body.appendChild(container);
    const detach = settings.attach(container);

    const url = container.querySelector<HTMLInputElement>('#customFeedUrl')!;
    const select = container.querySelector<HTMLSelectElement>('#customFeedPanel')!;
    expect(select.value).toBe('__new__');
    url.value = 'https://blog.example.net/feed';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(loadCustomFeedPanels()).toHaveLength(1));

    const [panel] = loadCustomFeedPanels();
    expect(panel).toEqual(expect.objectContaining({ title: 'Reactor Blog' }));
    expect(panel!.sources).toEqual([expect.objectContaining({ name: 'Reactor Blog', url: 'https://blog.example.net/feed' })]);
    await vi.waitFor(() => expect(container.querySelector('.custom-feeds-status')!.getAttribute('data-tone')).toBe('ok'));
    expect(container.querySelector('.custom-feeds-panel-title')!.textContent).toBe('Reactor Blog');
    expect(container.querySelector('.custom-feeds-source-host')!.textContent).toBe('blog.example.net');
    expect(select.value).toBe(panel!.id);

    detach();
    container.remove();
  });

  it('shows the proxy’s reason when a feed is refused and saves nothing', async () => {
    mockedFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Host not allowed for custom feeds' }), { status: 403 }));
    const container = document.createElement('div');
    const settings = renderCustomFeedsSettings();
    container.innerHTML = settings.html;
    const detach = settings.attach(container);
    container.querySelector<HTMLInputElement>('#customFeedUrl')!.value = 'https://blocked.example.net/feed';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(container.querySelector('.custom-feeds-status')!.getAttribute('data-tone')).toBe('error'));
    expect(container.querySelector('.custom-feeds-status')!.textContent).toMatch(/^That host is not allowed/);
    expect(loadCustomFeedPanels()).toEqual([]);
    detach();
  });
});
