import type { EmbedLayerId } from '../../shared/embed-panels';
import {
  buildPublicEmbedFrameSearch,
  EMBED_MAP_FRAME_PATH,
  type EmbedMapFrameResponse,
} from '../../shared/embed-map-frame';

const DEFAULT_FRAME_RETRY_MS = 60_000;
const MIN_FRAME_RETRY_MS = 1_000;
const MAX_FRAME_RETRY_MS = 60_000;

export class EmbedMapFrameUnavailableError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Embed map frame temporarily unavailable');
    this.name = 'EmbedMapFrameUnavailableError';
  }
}

function frameRetryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After'));
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_FRAME_RETRY_MS;
  return Math.min(MAX_FRAME_RETRY_MS, Math.max(MIN_FRAME_RETRY_MS, seconds * 1_000));
}

/**
 * Fetch the composed map frame.
 *
 * The request is built through `buildPublicEmbedFrameSearch`, the same module
 * the edge validates against, so the URL this client emits is exactly the one
 * that may be shared-cached. A header could not do that job: a CDN hit is
 * decided before the origin ever sees one (#5386). Cookies are omitted so a
 * signed-in viewer never authenticates the embed as themselves.
 */
export async function fetchEmbedMapFrame(
  layerIds: readonly EmbedLayerId[],
): Promise<EmbedMapFrameResponse> {
  // An empty layer set has no shared-cacheable shape; send the plain query.
  const search = layerIds.length > 0 ? buildPublicEmbedFrameSearch(layerIds) : 'layers=';
  const target = `${window.location.origin}${EMBED_MAP_FRAME_PATH}?${search}`;
  const resp = await globalThis.fetch(target, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
  });
  if (resp.status === 429 || resp.status >= 500) {
    throw new EmbedMapFrameUnavailableError(frameRetryAfterMs(resp));
  }
  if (!resp.ok) throw new Error(`Embed map frame request failed: ${resp.status}`);
  return await resp.json() as EmbedMapFrameResponse;
}
