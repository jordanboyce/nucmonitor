/**
 * GET /api/embed/map-frame?layers=…
 *
 * The single endpoint the embed map frame polls, replacing four separate
 * anonymous RPC calls. It accepts one parameter.
 *
 * NucMonitor has no paid plans: every caller gets every layer at one cadence,
 * with no key or grant.
 *
 * The URL — never a header — decides what a shared cache may hold, because a
 * CDN hit is answered before this function sees a header. That is #5386:
 *
 *   exact public shape   `layers=<canonical subset>&public=1`, and nothing
 *                        else. Keyless and shared-cacheable.
 *   everything else      served `private, no-store` with the same content.
 *
 * So a near-miss URL degrades to "correct but uncached" rather than to a
 * shared entry keyed on something the URL does not say.
 *
 * Partner deployments (docs/partner-access.md) serve no anonymous reads, and an
 * embed viewer has no session, so the frame is refused there.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import {
  checkEndpointRateLimit,
  type EndpointRateLimitOptions,
} from '../../server/_shared/rate-limit';
import { readRequiredSeed } from '../../server/_shared/required-seed';
import { drainResponseHeaders } from '../../server/_shared/response-headers';
import { BOOTSTRAP_CACHE_KEYS } from '../../shared/bootstrap-tier-keys.js';
import { isPartnerMode } from '../_partner-access.js';
import {
  cacheControlForEmbedFrame,
  composeEmbedMapFrame,
  parseRequestedLayers,
  type EmbedMapFrameSources,
} from '../../server/_shared/embed-map-frame';
import {
  classifyPublicEmbedFrameRequest,
  EMBED_MAP_FRAME_PATH,
  type EmbedMapFrameResponse,
} from '../../shared/embed-map-frame';
import type { EmbedLayerId } from '../../shared/embed-panels';
import { listEarthquakes } from '../../server/worldmonitor/seismology/v1/list-earthquakes';
import { listNaturalEvents } from '../../server/worldmonitor/natural/v1/list-natural-events';

const WEATHER_CACHE_KEY = BOOTSTRAP_CACHE_KEYS.weatherAlerts;

/** Build the generated handler context for an in-process source read. */
function handlerContext(req: Request) {
  return { request: req, pathParams: {}, headers: Object.fromEntries(req.headers) };
}

function buildSources(req: Request): EmbedMapFrameSources {
  const ctx = handlerContext(req);
  // Each upstream is called with ITS OWN defaults — zeros mean "handler
  // default" across these generated requests. Forwarding a caller-supplied
  // window or page size here would hand an anonymous caller the knobs this
  // endpoint exists to remove.
  return {
    listEarthquakes: async () =>
      (await listEarthquakes(ctx, { minMagnitude: 0, start: 0, end: 0, pageSize: 0, cursor: '' })).earthquakes,
    listNaturalEvents: async () => (await listNaturalEvents(ctx, { days: 30 })).events,
    listWeatherAlerts: async () => {
      const cached = await readRequiredSeed(WEATHER_CACHE_KEY, value => {
        const data = value as { alerts?: unknown[] } | null;
        return data && Array.isArray(data.alerts) ? data.alerts : undefined;
      });
      return cached;
    },
  };
}

export interface EmbedMapFrameHandlerDeps {
  getCorsHeaders: (req: Request) => Record<string, string>;
  checkRateLimit: (
    req: Request,
    pathname: string,
    cors: Record<string, string>,
    options?: EndpointRateLimitOptions,
  ) => Promise<Response | null>;
  composeFrame: (
    layers: readonly EmbedLayerId[],
    req: Request,
  ) => Promise<EmbedMapFrameResponse>;
  isPartnerMode: () => boolean;
}

const defaultDeps: EmbedMapFrameHandlerDeps = {
  getCorsHeaders,
  checkRateLimit: checkEndpointRateLimit,
  composeFrame: (layers, req) => composeEmbedMapFrame(layers, buildSources(req)),
  isPartnerMode,
};

export async function handleEmbedMapFrame(
  req: Request,
  deps: EmbedMapFrameHandlerDeps = defaultDeps,
): Promise<Response> {
  const cors = deps.getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'GET, HEAD, OPTIONS' },
    });
  }

  if (deps.isPartnerMode()) {
    return new Response(JSON.stringify({ error: 'partner_access_required' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // Decided purely by the URL: the only branch that may produce a
  // shared-cacheable body.
  const sharedLayers = classifyPublicEmbedFrameRequest(req.url, req.method);

  const limited = await deps.checkRateLimit(req, EMBED_MAP_FRAME_PATH, cors);
  if (limited) return limited;

  const url = new URL(req.url);
  const layers = sharedLayers ?? parseRequestedLayers(url.searchParams.get('layers'));
  const frame = await deps.composeFrame(layers, req);

  const headers: Record<string, string> = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': cacheControlForEmbedFrame(sharedLayers !== null),
  };
  if (drainResponseHeaders(req)?.['X-No-Cache']
    || Object.values(frame.layers).some(state => state === 'partial' || state === 'unavailable')) {
    headers['Cache-Control'] = cacheControlForEmbedFrame(false);
  }

  return new Response(JSON.stringify(frame), { status: 200, headers });
}

export default function handler(req: Request): Promise<Response> {
  return handleEmbedMapFrame(req);
}
