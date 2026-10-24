/**
 * The dashboard "Embed this map" dialog: one keyless iframe snippet, available
 * to every visitor, signed in or not.
 *
 * EventHandlers pulls the whole dashboard import graph, so the two dialog
 * methods are extracted and transpiled against injected dependencies.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { buildEmbedIframeSnippet } from '@/embed/embed-url';
import { declareOverlay } from '@/utils/open-modal';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'src/app/event-handlers.ts'), 'utf8');

function extractMethod(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1).replace(/^private\s+/, '');
    }
  }
  throw new Error(`unbalanced ${signature}`);
}

const js = ts.transpileModule(
  `class Harness { ${extractMethod('private openEmbedDialog(')}\n${extractMethod('private buildEmbedTier(')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
).outputText;

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const Harness = new Function(
  'buildEmbedIframeSnippet',
  'declareOverlay',
  `${js}\nreturn Harness;`,
)(
  buildEmbedIframeSnippet,
  // The real one, so the dialog's reload contract is observable here rather
  // than stubbed away (a source-text harness must name every free identifier).
  declareOverlay,
);

function makeInstance() {
  const instance = new Harness();
  instance.ctx = {};
  // about:blank keeps happy-dom from actually loading the preview iframe.
  // What the real getEmbedUrl() builds is covered by tests/embed-url.test.mts.
  instance.getEmbedUrl = () => 'about:blank';
  instance.closeEmbedDialog = () => {
    document.getElementById('embedModalOverlay')?.remove();
  };
  instance.copyToClipboard = vi.fn(async () => {});
  instance.boundEmbedModalKeydownHandler = null;
  return instance;
}

const sections = () => Array.from(document.querySelectorAll('.embed-modal-tier'));
const snippets = () =>
  Array.from(document.querySelectorAll<HTMLTextAreaElement>('.embed-snippet-textarea'))
    .map((el) => el.value);

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('embed dialog', () => {
  it('offers exactly one keyless iframe snippet', () => {
    makeInstance().openEmbedDialog();

    expect(sections()).toHaveLength(1);
    const [snippet] = snippets();
    expect(snippet).toContain('<iframe');
    expect(snippet).not.toContain('embed.js');
    expect(snippet).not.toContain('data-key');
    expect(document.querySelector('.embed-manage-keys-btn')).toBeNull();
  });

  it('says what the snippet gives, in the dialog rather than the docs', () => {
    makeInstance().openEmbedDialog();

    const text = sections()[0]?.textContent ?? '';
    expect(text).toContain('10 minutes');
    expect(text).toContain('signed in or not');
  });

  it('copies the snippet when its button is clicked', async () => {
    const instance = makeInstance();
    instance.openEmbedDialog();

    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.embed-copy-btn'));
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    await vi.waitFor(() => expect(instance.copyToClipboard).toHaveBeenCalled());

    expect(instance.copyToClipboard).toHaveBeenCalledWith(snippets()[0]);
  });
});
