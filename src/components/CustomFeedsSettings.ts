/**
 * Settings → Custom: add RSS/Atom sources and group them into custom panels.
 * State lives in src/services/custom-feeds.ts; the layout listens for its
 * change event and adds, updates or removes the dashboard panels.
 */
import '@/styles/custom-feeds.css';
import { h, replaceChildren } from '@/utils/dom-utils';
import { t } from '@/services/i18n';
import {
  CustomFeedError,
  MAX_CUSTOM_PANELS,
  MAX_SOURCES_PER_PANEL,
  addCustomFeedSource,
  createCustomFeedPanel,
  deleteCustomFeedPanel,
  loadCustomFeedPanels,
  onCustomFeedPanelsChanged,
  previewCustomFeed,
  removeCustomFeedSource,
  renameCustomFeedPanel,
  type CustomFeedPanelSpec,
} from '@/services/custom-feeds';

const NEW_PANEL = '__new__';

function errorMessage(err: unknown): string {
  if (err instanceof CustomFeedError) return err.message;
  if (err instanceof DOMException && err.name === 'AbortError') return '';
  return t('components.customFeeds.unexpectedError');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface CustomFeedsSettingsResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

export function renderCustomFeedsSettings(): CustomFeedsSettingsResult {
  return {
    html: '<div class="custom-feeds-settings" data-custom-feeds-root></div>',
    attach(container) {
      const root = container.querySelector<HTMLElement>('[data-custom-feeds-root]') ?? container;
      let preview: AbortController | null = null;

      const urlInput = h('input', {
        type: 'url',
        className: 'custom-feeds-input',
        id: 'customFeedUrl',
        placeholder: 'https://example.com/feed.xml',
        autocomplete: 'off',
        spellcheck: 'false',
      }) as HTMLInputElement;
      const nameInput = h('input', {
        type: 'text',
        className: 'custom-feeds-input',
        id: 'customFeedName',
        maxlength: '60',
        placeholder: t('components.customFeeds.namePlaceholder'),
      }) as HTMLInputElement;
      const panelSelect = h('select', { className: 'custom-feeds-input', id: 'customFeedPanel' }) as HTMLSelectElement;
      const newPanelInput = h('input', {
        type: 'text',
        className: 'custom-feeds-input',
        id: 'customFeedNewPanel',
        maxlength: '60',
        placeholder: t('components.customFeeds.newPanelPlaceholder'),
      }) as HTMLInputElement;
      const newPanelRow = h('label', { className: 'custom-feeds-field' },
        h('span', { className: 'custom-feeds-label' }, t('components.customFeeds.newPanelName')),
        newPanelInput,
      );
      const status = h('div', { className: 'custom-feeds-status', role: 'status', 'aria-live': 'polite' });
      const addButton = h('button', { type: 'submit', className: 'custom-feeds-add-btn' }, t('components.customFeeds.checkAndAdd')) as HTMLButtonElement;
      const list = h('div', { className: 'custom-feeds-list' });

      const setStatus = (message: string, tone: 'info' | 'ok' | 'error' = 'info') => {
        status.textContent = message;
        status.dataset.tone = tone;
      };

      const renderPanelOptions = (panels: CustomFeedPanelSpec[], selected?: string) => {
        const current = selected ?? panelSelect.value;
        const options = panels.map((panel) => h('option', { value: panel.id }, panel.title));
        if (panels.length < MAX_CUSTOM_PANELS) {
          options.push(h('option', { value: NEW_PANEL }, t('components.customFeeds.newPanelOption')));
        }
        replaceChildren(panelSelect, ...options);
        const values = Array.from(panelSelect.options, (o) => o.value);
        panelSelect.value = values.includes(current) ? current : (values[0] ?? NEW_PANEL);
        newPanelRow.hidden = panelSelect.value !== NEW_PANEL;
      };

      const renderList = (panels: CustomFeedPanelSpec[]) => {
        if (panels.length === 0) {
          replaceChildren(list, h('p', { className: 'custom-feeds-empty' }, t('components.customFeeds.noPanels')));
          return;
        }
        replaceChildren(list, ...panels.map((panel) => {
          const sources = panel.sources.length === 0
            ? h('li', { className: 'custom-feeds-source custom-feeds-source-empty' }, t('components.customFeeds.noSourcesShort'))
            : panel.sources.map((source) => h('li', { className: 'custom-feeds-source' },
              h('span', { className: 'custom-feeds-source-name' }, source.name),
              h('a', { className: 'custom-feeds-source-host', href: source.url, target: '_blank', rel: 'noopener noreferrer', title: source.url }, hostOf(source.url)),
              h('button', {
                type: 'button',
                className: 'custom-feeds-link-btn',
                'aria-label': t('components.customFeeds.removeSourceLabel', { name: source.name }),
                onClick: () => {
                  try { removeCustomFeedSource(panel.id, source.id); } catch (err) { setStatus(errorMessage(err), 'error'); }
                },
              }, t('components.customFeeds.remove')),
            ));
          return h('section', { className: 'custom-feeds-panel', dataset: { panelId: panel.id } },
            h('div', { className: 'custom-feeds-panel-header' },
              h('span', { className: 'custom-feeds-panel-title' }, panel.title),
              h('span', { className: 'custom-feeds-panel-count' }, `${panel.sources.length}/${MAX_SOURCES_PER_PANEL}`),
              h('button', {
                type: 'button',
                className: 'custom-feeds-link-btn',
                onClick: () => {
                  const next = window.prompt(t('components.customFeeds.renamePrompt'), panel.title);
                  if (next === null) return;
                  try { renameCustomFeedPanel(panel.id, next); } catch (err) { setStatus(errorMessage(err), 'error'); }
                },
              }, t('components.customFeeds.rename')),
              h('button', {
                type: 'button',
                className: 'custom-feeds-link-btn custom-feeds-danger',
                onClick: () => {
                  if (!window.confirm(t('components.customFeeds.deleteConfirm', { title: panel.title }))) return;
                  try { deleteCustomFeedPanel(panel.id); } catch (err) { setStatus(errorMessage(err), 'error'); }
                },
              }, t('components.customFeeds.deletePanel')),
            ),
            h('ul', { className: 'custom-feeds-sources' }, ...(Array.isArray(sources) ? sources : [sources])),
          );
        }));
      };

      const refresh = () => {
        const panels = loadCustomFeedPanels();
        renderPanelOptions(panels);
        renderList(panels);
      };

      const form = h('form', {
        className: 'custom-feeds-form',
        novalidate: true,
        onSubmit: async (event: Event) => {
          event.preventDefault();
          preview?.abort();
          const controller = new AbortController();
          preview = controller;
          addButton.disabled = true;
          setStatus(t('components.customFeeds.checking'));
          try {
            const checked = await previewCustomFeed(urlInput.value, controller.signal);
            if (controller.signal.aborted) return;
            let panelId = panelSelect.value;
            if (panelId === NEW_PANEL) {
              const title = newPanelInput.value.trim() || checked.title || hostOf(checked.url);
              panelId = createCustomFeedPanel(title).id;
            }
            const source = addCustomFeedSource(panelId, { name: nameInput.value.trim() || checked.title, url: checked.url });
            urlInput.value = '';
            nameInput.value = '';
            newPanelInput.value = '';
            renderPanelOptions(loadCustomFeedPanels(), panelId);
            setStatus(t('components.customFeeds.added', { name: source.name, count: checked.itemCount }), 'ok');
          } catch (err) {
            const message = errorMessage(err);
            if (message) setStatus(message, 'error');
          } finally {
            if (preview === controller) preview = null;
            addButton.disabled = false;
          }
        },
      },
        h('label', { className: 'custom-feeds-field' },
          h('span', { className: 'custom-feeds-label' }, t('components.customFeeds.feedUrl')),
          urlInput,
        ),
        h('label', { className: 'custom-feeds-field' },
          h('span', { className: 'custom-feeds-label' }, t('components.customFeeds.name')),
          nameInput,
        ),
        h('label', { className: 'custom-feeds-field' },
          h('span', { className: 'custom-feeds-label' }, t('components.customFeeds.panel')),
          panelSelect,
        ),
        newPanelRow,
        h('div', { className: 'custom-feeds-actions' }, addButton, status),
      );

      panelSelect.addEventListener('change', () => {
        newPanelRow.hidden = panelSelect.value !== NEW_PANEL;
      });

      replaceChildren(root,
        h('div', { className: 'custom-feeds-intro' },
          h('h2', null, t('components.customFeeds.heading')),
          h('p', null, t('components.customFeeds.intro')),
        ),
        form,
        h('h3', { className: 'custom-feeds-subheading' }, t('components.customFeeds.yourPanels')),
        list,
      );
      refresh();
      const unsubscribe = onCustomFeedPanelsChanged(refresh);
      return () => {
        unsubscribe();
        preview?.abort();
      };
    },
  };
}
