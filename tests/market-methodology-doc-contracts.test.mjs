import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('market methodology contract surfaces', () => {
  // The Fear & Greed seeder, its brief, the FSI panel doc and the disease
  // methodology doc were removed in the NucMonitor trim. GetFearGreedIndex
  // still ships, so its proto and OpenAPI keep documenting the header FSI.
  const fearGreedProto = readRepo('proto/worldmonitor/market/v1/get_fear_greed_index.proto');
  const marketOpenApi = readRepo('docs/api/MarketService.openapi.yaml');

  it('documents the bespoke Fear & Greed header FSI separately from the FSI panel', () => {
    const formula = /\(HYG \/ TLT\) \/ \(VIX \* HY(?:_OAS| OAS) \/ 100\)/;

    for (const [label, text] of [
      ['fear-greed proto', fearGreedProto],
      ['MarketService OpenAPI', marketOpenApi],
    ]) {
      assert.match(text, formula, `${label} must document the header FSI formula`);
      assert.match(text, /KCFSI\/ECB FSI panel|KCFSI or ECB CISS\/EU FSI composite|KCFSI\/ECB FSI/, `${label} must distinguish the header FSI from the panel composite`);
    }
  });
});
