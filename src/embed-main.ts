import './styles/base-layer.css';
import './styles/embed.css';
import { initI18n } from '@/services/i18n';
import { parseEmbedParams } from '@/embed/embed-url';
import { mountEmbedMapPanel } from '@/embed/panels/map';

function mountError(root: HTMLElement, message: string): void {
  root.textContent = '';
  const error = document.createElement('div');
  error.className = 'wm-embed-error';
  error.textContent = message;
  root.appendChild(error);
}

async function bootEmbed(): Promise<void> {
  const root = document.getElementById('embedRoot');
  if (!root) return;

  try {
    const params = parseEmbedParams(window.location.search);
    document.documentElement.dataset.theme = params.theme;
    document.documentElement.dataset.variant = params.variant;
    document.body.dataset.embedPanel = params.panel ?? 'unknown';
    document.body.dataset.embedReady = 'false';

    await initI18n();

    if (!params.panel) {
      mountError(root, `Unknown NucMonitor embed panel "${params.requestedPanel}".`);
      document.body.dataset.embedReady = 'error';
      return;
    }

    let destroy: (() => void) | undefined;
    if (params.panel === 'map') {
      destroy = await mountEmbedMapPanel(root, params);
    }

    document.title = params.panel === 'map'
      ? 'NucMonitor Live Map Embed'
      : 'NucMonitor Panel Embed';
    document.body.dataset.embedReady = 'true';
    if (destroy) {
      window.addEventListener('pagehide', destroy, { once: true });
    }
  } catch (error) {
    console.error('[embed] Failed to boot panel:', error);
    mountError(root, 'NucMonitor embed could not load.');
    document.body.dataset.embedReady = 'error';
  }
}

void bootEmbed();
