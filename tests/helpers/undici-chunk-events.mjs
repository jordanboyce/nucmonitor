// Whether this Node's bundled undici publishes `undici:request:bodyChunkReceived`.
// Node 24 (the CI and .nvmrc runtime) does; Node 22's undici 6.x does not, so
// the natural-events wire-byte counters stay null there by design ("bytes
// remain unknown until a chunk is observed"). Tests probe once against a
// loopback server instead of parsing version strings.
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { createServer } from 'node:http';

async function probe() {
  const chunks = channel('undici:request:bodyChunkReceived');
  let seen = false;
  const listener = () => { seen = true; };
  const server = createServer((_req, res) => res.end('x'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  chunks.subscribe(listener);
  try {
    await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  } finally {
    chunks.unsubscribe(listener);
    server.closeAllConnections();
    server.close();
  }
  return seen;
}

export const NATIVE_BODY_CHUNK_EVENTS = await probe();

/** The wire-byte value a diagnostics snapshot should carry on this runtime. */
export function expectedWireBytes(bytes) {
  return NATIVE_BODY_CHUNK_EVENTS ? bytes : null;
}
