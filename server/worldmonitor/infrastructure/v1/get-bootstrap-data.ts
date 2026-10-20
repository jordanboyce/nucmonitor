import {
  ValidationError,
  type InfrastructureServiceHandler,
  type ServerContext,
  type GetBootstrapDataRequest,
  type GetBootstrapDataResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../../../_shared/cache-keys';
// @ts-expect-error — Edge-safe JS helper
import { sanitizeBootstrapValue } from '../../../../api/_bootstrap-public-payload.js';
// @ts-expect-error — Edge-safe JS helper, shared with api/bootstrap.js
import { validateImfDataset } from '../../../../api/_imf-dataset.js';
import { getCachedJsonBatch } from '../../../_shared/redis';

const isRegisteredKey = (key: string) => Object.prototype.hasOwnProperty.call(BOOTSTRAP_CACHE_KEYS, key);
const isTieredKey = (key: string) => BOOTSTRAP_TIERS[key] === 'fast' || BOOTSTRAP_TIERS[key] === 'slow';

// A multi-key read costs at most the fast and slow tiers together, which are
// already servable; on-demand keys run to megabytes each, so they go alone.
function isServableKeySelection(keys: string[]): boolean {
  const unique = new Set(keys);
  if (unique.size === 0 || ![...unique].every(isRegisteredKey)) return false;
  return unique.size === 1 || [...unique].every(isTieredKey);
}

function buildRegistry(req: GetBootstrapDataRequest): Record<string, string> {
  if ((req.tier && req.keys.length > 0)
    || (req.tier && req.tier !== 'fast' && req.tier !== 'slow')
    || (!req.tier && !isServableKeySelection(req.keys))) {
    throw new ValidationError([{ field: req.tier ? 'tier' : 'keys', description: 'Specify a fast/slow tier, fast/slow bootstrap keys, or one on-demand bootstrap key' }]);
  }
  if (req.tier === 'slow' || req.tier === 'fast') {
    return Object.fromEntries(
      Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([key]) => BOOTSTRAP_TIERS[key] === req.tier),
    );
  }
  return Object.fromEntries(
    Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([key]) => req.keys.includes(key)),
  );
}

/**
 * Fetch named datasets or a fixed public tier; never enumerate the full registry.
 */
export const getBootstrapData: InfrastructureServiceHandler['getBootstrapData'] = async (
  _ctx: ServerContext,
  req: GetBootstrapDataRequest,
): Promise<GetBootstrapDataResponse> => {
  const registry = buildRegistry(req);

  const names = Object.keys(registry);
  const cacheKeys = Object.values(registry);

  try {
    const cached = await getCachedJsonBatch(cacheKeys, true);
    const data: Record<string, string> = {};
    const missing: string[] = [];

    for (let i = 0; i < names.length; i += 1) {
      const keyName = names[i]!;
      const cacheKey = cacheKeys[i]!;
      const raw = cached.get(cacheKey);
      // Same gate as api/bootstrap.js: a malformed IMF dataset is `missing`,
      // malformed country rows are dropped. Non-IMF keys pass through.
      const value = raw === undefined ? undefined : validateImfDataset(keyName, raw);
      if (value === undefined) {
        missing.push(keyName);
        continue;
      }
      data[keyName] = JSON.stringify(sanitizeBootstrapValue(keyName, value));
    }

    return { data, missing };
  } catch {
    return { data: {}, missing: names };
  }
};
