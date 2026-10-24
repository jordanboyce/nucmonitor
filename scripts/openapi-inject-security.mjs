#!/usr/bin/env node
/**
 * Inject the auth security contract into the generated OpenAPI specs.
 *
 * The sebuf `protoc-gen-openapiv3` plugin (proto/buf.gen.yaml) has no option or
 * annotation for describing authentication, so every generated spec omits
 * `components.securitySchemes`, a root `security` requirement, and the `401`
 * response — even though every non-public WorldMonitor RPC is authenticated at
 * the gateway (server/gateway.ts). This post-generation step adds them so the
 * published contract matches runtime reality. See umbrella issue #4599 (root
 * cause #1).
 *
 * Wired into `make generate` (runs after `buf generate`) and exposed as
 * `npm run gen:openapi:security`. Idempotent: re-running (or a fresh regenerate
 * followed by this step) yields byte-identical output.
 *
 * Two artifact families:
 *   1. docs/api/<Service>.openapi.json — full injection (schemes + root
 *      API-key security + per-operation 401 + public-gate 403
 *      responses/notes). Re-serialized byte-faithfully to the generator's
 *      format (recursively sorted keys, Go-style <>&/U+2028/U+2029 escaping, no
 *      trailing newline) so the diff is additions-only.
 *   2. docs/api/<Service>.openapi.yaml and docs/api/worldmonitor.openapi.yaml —
 *      docs-facing YAML (the bundle is copied to public/openapi.yaml at build).
 *      The generator's YAML emitter cannot be reproduced by js-yaml (a re-dump
 *      reformats ~100% of 21k lines), so YAML gets formatting-preserving
 *      surgical insertions. Each YAML artifact receives the SAME contract its
 *      JSON sibling carries (#4650): top-level securitySchemes (API key, plus
 *      TrustReviewKey by path presence) + root API-key security + the
 *      UnauthorizedError schema + per-operation 401 / public security:[]
 *      opt-outs / review-key stamping, then per-operation public-gate 403
 *      responses and notes.
 *      Like the sibling injectors this runs in the `make generate` codegen
 *      context (no npm deps guaranteed), so it has no external imports: paths
 *      are enumerated by text scan and all writes are surgical text insertions.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serialize,
  eq,
  readPublicNoAuthPaths,
  PUBLIC_FORBIDDEN_GATES,
  TRUST_REVIEW_KEY_PATHS,
} from './lib/openapi-codegen.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const bundlePath = resolve(apiDir, 'worldmonitor.openapi.yaml');

const CHECK = process.argv.includes('--check');

// PUBLIC_PATHS is parsed from the gateway source of truth
// (scripts/lib/openapi-codegen.mjs) so the published auth contract can never
// drift from runtime; the parser fails closed.
const PUBLIC_PATHS = readPublicNoAuthPaths();

// Review-key routes rely on the gateway skipping the API-key check, and carry
// their own 401 instead of a bot-verification 403. Fail closed
// if a path ever lands in a set that contradicts that.
for (const path of TRUST_REVIEW_KEY_PATHS) {
  if (!PUBLIC_PATHS.has(path)) {
    throw new Error(`${path} is in TRUST_REVIEW_KEY_PATHS but not PUBLIC_NO_AUTH_RPC_PATHS — the gateway would demand an API key before the review key is checked`);
  }
  if (PUBLIC_FORBIDDEN_GATES.has(path)) {
    throw new Error(`${path} is in TRUST_REVIEW_KEY_PATHS and PUBLIC_FORBIDDEN_GATES — a path has exactly one auth contract`);
  }
}

// ── Contract definitions ──────────────────────────────────────────────────
// Header names mirror the gateway's accepted public API-key headers
// (server/gateway.ts: X-WorldMonitor-Key / X-Api-Key) and docs/api-platform.mdx.
const API_KEY_SECURITY_SCHEMES = {
  WorldMonitorKey: {
    type: 'apiKey',
    in: 'header',
    name: 'X-WorldMonitor-Key',
    description: 'WorldMonitor API key.',
  },
  ApiKeyHeader: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Api-Key',
    description: 'Alias header for the WorldMonitor API key (X-WorldMonitor-Key).',
  },
};

const TRUST_REVIEW_SECURITY_SCHEMES = {
  TrustReviewKey: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Trust-Review-Key',
    description: 'Operator review key (the server TRUST_REVIEW_SECRET). Required by the error-report review operations; a WorldMonitor API key does not authorize them.',
  },
};

// Root requirement — any ONE API-key scheme satisfies it (OpenAPI OR
// semantics).
const ROOT_SECURITY = [
  { WorldMonitorKey: [] },
  { ApiKeyHeader: [] },
];

const TRUST_REVIEW_OPERATION_SECURITY = [{ TrustReviewKey: [] }];

// The handler throws ApiError(401, 'Unauthorized'), which error-mapper renders
// as the generated Error schema (`{ message }`), not UnauthorizedError.
const TRUST_REVIEW_UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid X-Trust-Review-Key, or review is not configured on the server.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
};

const UNAUTHORIZED_SCHEMA = {
  type: 'object',
  description:
    'Returned when the API key is missing, malformed, or lacks current API access.',
  properties: {
    error: { type: 'string', description: 'Human-readable error message.' },
  },
  required: ['error'],
};

const UNAUTHORIZED_RESPONSE = {
  description: 'Missing or invalid API key.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/UnauthorizedError' },
    },
  },
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

function appendGateNote(description, note) {
  const text = String(description ?? '').trim();
  if (!text) return note;
  if (text.includes(note)) return text;
  return `${text} ${note}`;
}

// ── Per-service JSON injection ──────────────────────────────────────────────
function injectJson(spec) {
  let changed = false;
  spec.components ||= {};
  spec.components.schemas ||= {};

  const hasTrustReviewPath = Object.keys(spec.paths ?? {}).some((path) => TRUST_REVIEW_KEY_PATHS.has(path));
  const expectedSecuritySchemes = {
    ...API_KEY_SECURITY_SCHEMES,
    ...(hasTrustReviewPath ? TRUST_REVIEW_SECURITY_SCHEMES : {}),
  };
  if (!eq(spec.components.securitySchemes, expectedSecuritySchemes)) {
    spec.components.securitySchemes = expectedSecuritySchemes;
    changed = true;
  }
  if (!eq(spec.security, ROOT_SECURITY)) {
    spec.security = ROOT_SECURITY;
    changed = true;
  }
  // UnauthorizedError backs the per-operation 401, which only NON-public ops
  // carry. In an all-public spec (Leads/Natural/Seismology/Unrest) no op
  // references it, so injecting it unconditionally leaves an orphaned schema —
  // gate on the spec having at least one non-public op.
  const hasNonPublicOp = Object.keys(spec.paths ?? {}).some((path) => !PUBLIC_PATHS.has(path));
  if (hasNonPublicOp && !eq(spec.components.schemas.UnauthorizedError, UNAUTHORIZED_SCHEMA)) {
    spec.components.schemas.UnauthorizedError = UNAUTHORIZED_SCHEMA;
    changed = true;
  }
  // No operation documents an authenticated 403 any more, so the former
  // ForbiddenError schema would be orphaned.
  if (spec.components.schemas.ForbiddenError !== undefined) {
    delete spec.components.schemas.ForbiddenError;
    changed = true;
  }
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const isPublic = PUBLIC_PATHS.has(path);
    const publicForbiddenGate = PUBLIC_FORBIDDEN_GATES.get(path);
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      op.responses ||= {};
      if (TRUST_REVIEW_KEY_PATHS.has(path)) {
        // Public at the gateway, but the handler 401s without the review key.
        if (!eq(op.security, TRUST_REVIEW_OPERATION_SECURITY)) {
          op.security = TRUST_REVIEW_OPERATION_SECURITY;
          changed = true;
        }
        if (!eq(op.responses['401'], TRUST_REVIEW_UNAUTHORIZED_RESPONSE)) {
          op.responses['401'] = TRUST_REVIEW_UNAUTHORIZED_RESPONSE;
          changed = true;
        }
        if (op.responses['403'] !== undefined) { delete op.responses['403']; changed = true; }
      } else if (isPublic) {
        // Public RPC: override the root requirement with an empty security
        // (marks the operation as unauthenticated) and carry no 401-for-missing-key.
        if (!eq(op.security, [])) { op.security = []; changed = true; }
        if (op.responses['401'] !== undefined) { delete op.responses['401']; changed = true; }
        if (publicForbiddenGate) {
          const nextDescription = appendGateNote(op.description, publicForbiddenGate.note);
          if (op.description !== nextDescription) {
            op.description = nextDescription;
            changed = true;
          }
          if (!eq(op.responses['403'], publicForbiddenGate.response)) {
            op.responses['403'] = publicForbiddenGate.response;
            changed = true;
          }
        } else if (op.responses['403'] !== undefined) {
          delete op.responses['403'];
          changed = true;
        }
      } else {
        // Authenticated op: inherits the root API-key requirement, answers 401
        // without a valid key, and has no route-specific 403.
        if (op.security !== undefined) {
          delete op.security;
          changed = true;
        }
        if (!eq(op.responses['401'], UNAUTHORIZED_RESPONSE)) {
          op.responses['401'] = UNAUTHORIZED_RESPONSE;
          changed = true;
        }
        if (op.responses['403'] !== undefined) {
          delete op.responses['403'];
          changed = true;
        }
      }
    }
  }
  return changed;
}

// ── Shared YAML auth-contract insertion (formatting-preserving) ──────────────
// YAML artifacts use 4-space indentation with top-level keys at column 0. The
// same helpers serve both the per-service YAML files and the bundle so every
// YAML artifact reaches parity with its JSON sibling (#4650).
function yamlRootSecurityBlock() {
  // Top-level `security:` list (API-key schemes only, matching ROOT_SECURITY);
  // 4-space list items to match the bundle's `servers:` style.
  return [
    'security:',
    '    - WorldMonitorKey: []',
    '    - ApiKeyHeader: []',
  ].join('\n');
}

function yamlSecuritySchemesBlock(hasTrustReview) {
  // Child of top-level `components:` — 4-space key, 8-space scheme names,
  // 12-space fields. TrustReviewKey is appended only when the artifact has a
  // review-key operation, mirroring injectJson.
  const L = [
    '    securitySchemes:',
    '        WorldMonitorKey:',
    '            type: apiKey',
    '            in: header',
    '            name: X-WorldMonitor-Key',
    '            description: WorldMonitor API key.',
    '        ApiKeyHeader:',
    '            type: apiKey',
    '            in: header',
    '            name: X-Api-Key',
    '            description: Alias header for the WorldMonitor API key (X-WorldMonitor-Key).',
  ];
  if (hasTrustReview) {
    L.push(
      '        TrustReviewKey:',
      '            type: apiKey',
      '            in: header',
      '            name: X-Trust-Review-Key',
      `            description: ${TRUST_REVIEW_SECURITY_SCHEMES.TrustReviewKey.description}`,
    );
  }
  return L.join('\n');
}

function findTopLevelBlock(lines, key) {
  const start = lines.indexOf(key + ':');
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

function findComponentsChildBlock(lines, key) {
  const componentsIndex = lines.indexOf('components:');
  if (componentsIndex === -1) {
    return { componentsIndex, block: null };
  }
  for (let i = componentsIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
    if (line !== `    ${key}:`) continue;
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next && !next.startsWith(' ') && !next.startsWith('\t')) break;
      if (/^ {4}[^ ].*:/.test(next)) break;
      end++;
    }
    return { componentsIndex, block: { start: i, end, text: lines.slice(i, end).join('\n') } };
  }
  return { componentsIndex, block: null };
}

function ensureYamlRootSecurity(lines) {
  const expected = yamlRootSecurityBlock();
  const block = findTopLevelBlock(lines, 'security');
  if (block) {
    if (block.text === expected) return false;
    lines.splice(block.start, block.end - block.start, ...expected.split('\n'));
    return true;
  }
  // Insert root `security:` immediately before top-level `paths:`.
  const pathsIndex = lines.indexOf('paths:');
  if (pathsIndex === -1) throw new Error('yaml: could not find top-level `paths:` anchor for security block');
  lines.splice(pathsIndex, 0, ...expected.split('\n'));
  return true;
}

function ensureYamlSecuritySchemes(lines, hasTrustReview) {
  const expected = yamlSecuritySchemesBlock(hasTrustReview);
  const { componentsIndex, block } = findComponentsChildBlock(lines, 'securitySchemes');
  if (componentsIndex === -1) {
    throw new Error('yaml: could not find top-level `components:` anchor for securitySchemes block');
  }
  if (block) {
    if (block.text === expected) return false;
    lines.splice(block.start, block.end - block.start, ...expected.split('\n'));
    return true;
  }
  // Insert `securitySchemes:` as the first child under top-level `components:`.
  lines.splice(componentsIndex + 1, 0, ...expected.split('\n'));
  return true;
}

// ── Service/bundle YAML public-gate insertion (formatting-preserving) ────────
const YAML_METHOD_LINE_RE = /^ {8}(get|post|put|delete|patch|options|head):$/;

function yamlPublicForbiddenResponse(gate) {
  const description = gate?.response?.description ?? 'Bot verification failed.';
  const schemaRef = gate?.response?.content?.['application/json']?.schema?.$ref ?? '#/components/schemas/Error';
  return [
    '                "403":',
    `                    description: ${JSON.stringify(description)}`,
    '                    content:',
    '                        application/json:',
    '                            schema:',
    `                                $ref: '${schemaRef}'`,
  ];
}

const YAML_UNAUTHORIZED_RESPONSE = [
  '                "401":',
  '                    description: Missing or invalid API key.',
  '                    content:',
  '                        application/json:',
  '                            schema:',
  "                                $ref: '#/components/schemas/UnauthorizedError'",
];

const YAML_TRUST_REVIEW_UNAUTHORIZED_RESPONSE = [
  '                "401":',
  `                    description: ${TRUST_REVIEW_UNAUTHORIZED_RESPONSE.description}`,
  '                    content:',
  '                        application/json:',
  '                            schema:',
  "                                $ref: '#/components/schemas/Error'",
];

const YAML_UNAUTHORIZED_SCHEMA = [
  '        UnauthorizedError:',
  '            type: object',
  '            properties:',
  '                error:',
  '                    type: string',
  '                    description: Human-readable error message.',
  '            required:',
  '                - error',
  '            description: Returned when the API key is missing, malformed, or lacks current API access.',
];

const YAML_TRUST_REVIEW_OPERATION_SECURITY = [
  '            security:',
  '                - TrustReviewKey: []',
];

const YAML_OPERATION_SECURITY = {
  public: ['            security: []'],
  'trust-review': YAML_TRUST_REVIEW_OPERATION_SECURITY,
};

function findYamlPathRange(lines, path) {
  const start = lines.indexOf(`    ${path}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line && !line.startsWith('        ')) break;
    end++;
  }
  return { start, end };
}

// A single-line description may be emitted as a quoted scalar (the generator
// single- or double-quotes any value containing `: `, a leading indicator
// char, etc.). Append the note INSIDE the quotes so the result stays one valid
// scalar rather than a closing quote followed by bare text (which is a YAML
// parse error). The note text is pure ASCII with no quote/backslash chars, so
// the already-escaped inner content needs no re-escaping. Returns the scalar
// unchanged when appendFn is a no-op, preserving idempotency.
function appendNoteToYamlScalar(scalar, appendFn) {
  const quote = scalar[0];
  const isQuoted = (quote === "'" || quote === '"')
    && scalar.length >= 2 && scalar[scalar.length - 1] === quote;
  const inner = isQuoted ? scalar.slice(1, -1) : scalar;
  const nextInner = appendFn(inner);
  if (nextInner === inner) return scalar;
  return isQuoted ? `${quote}${nextInner}${quote}` : nextInner;
}

function lastYamlBlockContentIndex(lines, descIndex, exclusiveEnd) {
  let contentIndex = exclusiveEnd - 1;
  while (contentIndex > descIndex && lines[contentIndex].trim() === '') contentIndex--;
  return contentIndex;
}

function appendNoteToYamlBlock(lines, descIndex, blockEnd, note) {
  const contentIndex = lastYamlBlockContentIndex(lines, descIndex, blockEnd);
  if (contentIndex === descIndex) {
    lines.splice(blockEnd, 0, '                ' + note);
    return;
  }
  lines[contentIndex] = lines[contentIndex].replace(/\s+$/, '') + ' ' + note;
}

function normalizeYamlBlockNoteLine(lines, descIndex, blockEnd, isNoteLine) {
  const noteIndex = lines.findIndex((line, index) => (
    index > descIndex && index < blockEnd && isNoteLine(line.trim())
  ));
  if (noteIndex === -1) return false;
  const contentIndex = lastYamlBlockContentIndex(lines, descIndex, noteIndex);
  if (contentIndex === descIndex) return false;
  lines[contentIndex] = lines[contentIndex].replace(/\s+$/, '') + ' ' + lines[noteIndex].trim();
  lines.splice(noteIndex, 1);
  return true;
}

function ensureYamlGateDescription(lines, path, method, note) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;
  const descIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line.startsWith('            description:')
  ));

  if (descIndex === -1) {
    const operationIdIndex = lines.findIndex((line, index) => (
      index > op.start && index < op.end && line.startsWith('            operationId:')
    ));
    const insertAt = operationIdIndex === -1 ? op.start + 1 : operationIdIndex;
    lines.splice(insertAt, 0, '            description: ' + note);
    return true;
  }

  const line = lines[descIndex];
  if (/^ {12}description:\s*[|>]/.test(line)) {
    let blockEnd = descIndex + 1;
    while (blockEnd < lines.length) {
      const next = lines[blockEnd];
      if (next && !next.startsWith('                ')) break;
      blockEnd++;
    }
    const blockText = lines.slice(descIndex, blockEnd).join('\n');
    if (normalizeYamlBlockNoteLine(lines, descIndex, blockEnd, (text) => text === note)) return true;
    if (blockText.includes(note)) return false;
    appendNoteToYamlBlock(lines, descIndex, blockEnd, note);
    return true;
  }

  const prefix = '            description: ';
  if (!line.startsWith(prefix)) return false;
  const current = line.slice(prefix.length);
  const next = appendNoteToYamlScalar(current, (text) => appendGateNote(text, note));
  if (next === current) return false;
  lines[descIndex] = prefix + next;
  return true;
}

function findYamlResponseRange(lines, op, statusLine) {
  const start = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line === statusLine
  ));
  if (start === -1) return null;

  let end = start + 1;
  while (end < op.end) {
    const line = lines[end];
    if (line && /^ {16}[^ ].*:/.test(line)) break;
    if (line && !line.startsWith('                    ')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

function ensureYamlForbiddenResponse(lines, path, method, responseLines) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;

  const expected = responseLines.join('\n');
  const existing = findYamlResponseRange(lines, op, '                "403":');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...responseLines);
    return true;
  }

  const responsesIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line === '            responses:'
  ));
  if (responsesIndex === -1) return false;

  let responseEnd = responsesIndex + 1;
  while (responseEnd < op.end) {
    const line = lines[responseEnd];
    if (line && !line.startsWith('                ')) break;
    responseEnd++;
  }

  const defaultIndex = lines.findIndex((line, index) => (
    index > responsesIndex && index < responseEnd && line === '                default:'
  ));
  const insertAt = defaultIndex === -1 ? responseEnd : defaultIndex;
  lines.splice(insertAt, 0, ...responseLines);
  return true;
}
function findYamlSchemaRange(lines, schemaName) {
  const start = lines.indexOf(`        ${schemaName}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line && /^ {8}[^ ].*:/.test(line)) break;
    if (line && !line.startsWith('            ')) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

function injectYamlPublicGateContract(text) {
  const lines = text.split('\n');
  let changed = false;
  const methodsByPath = new Map(
    enumerateYamlOperations(lines).map(({ path, methods }) => [path, methods]),
  );

  for (const [path, gate] of PUBLIC_FORBIDDEN_GATES) {
    // injectJson applies the bot-verification 403 + note only inside its
    // isPublic branch, so a forbidden-gate path that is not actually public
    // must not receive the gate 403 here — it takes the authenticated 401 path
    // instead. Skip non-public gate paths to keep byte-parity with the JSON.
    if (!PUBLIC_PATHS.has(path)) continue;
    const methods = methodsByPath.get(path);
    if (!methods) continue;
    for (const method of methods) {
      changed = ensureYamlGateDescription(lines, path, method, gate.note) || changed;
      changed = ensureYamlForbiddenResponse(lines, path, method, yamlPublicForbiddenResponse(gate)) || changed;
    }
  }

  return { text: lines.join('\n'), changed };
}

function ensureYamlUnauthorizedSchema(lines) {
  const existing = findYamlSchemaRange(lines, 'UnauthorizedError');
  if (existing) {
    const expected = YAML_UNAUTHORIZED_SCHEMA.join('\n');
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...YAML_UNAUTHORIZED_SCHEMA);
    return true;
  }
  const schemasIndex = lines.indexOf('    schemas:');
  if (schemasIndex === -1) return false;
  lines.splice(schemasIndex + 1, 0, ...YAML_UNAUTHORIZED_SCHEMA);
  return true;
}

// Method-scoped operation range (a path may carry more than one HTTP method,
// e.g. /api/v2/shipping/webhooks has both get and post).
function findYamlOperationRangeForMethod(lines, path, method) {
  const range = findYamlPathRange(lines, path);
  if (!range) return null;
  const methodLine = `        ${method}:`;
  const methodIndex = lines.findIndex((line, index) => (
    index > range.start && index < range.end && line === methodLine
  ));
  if (methodIndex === -1) return null;
  let end = range.end;
  for (let i = methodIndex + 1; i < range.end; i++) {
    if (YAML_METHOD_LINE_RE.test(lines[i])) { end = i; break; }
  }
  return { start: methodIndex, end };
}

function ensureYamlUnauthorizedResponse(lines, path, method, responseLines = YAML_UNAUTHORIZED_RESPONSE) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;

  const expected = responseLines.join('\n');
  const existing = findYamlResponseRange(lines, op, '                "401":');
  if (existing) {
    if (existing.text === expected) return false;
    lines.splice(existing.start, existing.end - existing.start, ...responseLines);
    return true;
  }

  const responsesIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line === '            responses:'
  ));
  if (responsesIndex === -1) return false;

  let responseEnd = responsesIndex + 1;
  while (responseEnd < op.end) {
    const line = lines[responseEnd];
    if (line && !line.startsWith('                ')) break;
    responseEnd++;
  }

  // Insert 401 before the 403 when present, else before `default:`, so the
  // order stays 2xx → 401 → 403 → default whichever pass runs first.
  const forbiddenIndex = lines.findIndex((line, index) => (
    index > responsesIndex && index < responseEnd && line === '                "403":'
  ));
  const defaultIndex = lines.findIndex((line, index) => (
    index > responsesIndex && index < responseEnd && line === '                default:'
  ));
  const insertAt = forbiddenIndex !== -1
    ? forbiddenIndex
    : (defaultIndex === -1 ? responseEnd : defaultIndex);
  lines.splice(insertAt, 0, ...responseLines);
  return true;
}

function findYamlOperationSecurityRange(lines, op) {
  const start = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line.startsWith('            security:')
  ));
  if (start === -1) return null;
  // `security: []` is a single inline line; the review-key form is a block of
  // 16-space list items.
  if (lines[start] === '            security: []') return { start, end: start + 1 };
  let end = start + 1;
  while (end < op.end) {
    const line = lines[end];
    if (line && !line.startsWith('                ')) break;
    end++;
  }
  return { start, end };
}

// kind: 'public' → `security: []` (opt out); 'trust-review' → the review key
// alone.
function ensureYamlOperationSecurity(lines, path, method, kind) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;
  const desired = YAML_OPERATION_SECURITY[kind];

  const existing = findYamlOperationSecurityRange(lines, op);
  if (existing) {
    if (lines.slice(existing.start, existing.end).join('\n') === desired.join('\n')) return false;
    lines.splice(existing.start, existing.end - existing.start, ...desired);
    return true;
  }

  const operationIdIndex = lines.findIndex((line, index) => (
    index > op.start && index < op.end && line.startsWith('            operationId:')
  ));
  const insertAt = operationIdIndex === -1 ? op.start + 1 : operationIdIndex + 1;
  lines.splice(insertAt, 0, ...desired);
  return true;
}

// Remove any operation-level `security:` block. Mirrors injectJson's
// `delete op.security` for authenticated ops so they inherit the root API-key
// requirement (otherwise the YAML would drift from its JSON sibling).
function removeYamlOperationSecurity(lines, path, method) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;
  const existing = findYamlOperationSecurityRange(lines, op);
  if (!existing) return false;
  lines.splice(existing.start, existing.end - existing.start);
  return true;
}

// Remove a stale `401` response. Mirrors injectJson's `delete op.responses['401']`
// for public ops so that a path moved into PUBLIC_NO_AUTH_RPC_PATHS drops the
// 401-for-missing-key it can no longer return.
function removeYamlUnauthorizedResponse(lines, path, method) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;
  const existing = findYamlResponseRange(lines, op, '                "401":');
  if (!existing) return false;
  lines.splice(existing.start, existing.end - existing.start);
  return true;
}

// Only PUBLIC_FORBIDDEN_GATES operations document a 403. Remove any other
// stale 403 (mirrors injectJson's `delete op.responses['403']`).
function removeYamlForbiddenResponse(lines, path, method) {
  const op = findYamlOperationRangeForMethod(lines, path, method);
  if (!op) return false;
  const existing = findYamlResponseRange(lines, op, '                "403":');
  if (!existing) return false;
  lines.splice(existing.start, existing.end - existing.start);
  return true;
}

// Enumerate operations by text scan (no YAML parser): a path is a 4-space key
// beginning with `/`; its methods are the 8-space HTTP-verb keys inside the
// path block (which ends at the next path or any shallower-indented line,
// matching findYamlPathRange). Handles multi-method paths.
function enumerateYamlOperations(lines) {
  const operations = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^ {4}(\/\S+):$/);
    if (!match) continue;
    const methods = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line && !line.startsWith('        ')) break;
      const methodMatch = line.match(YAML_METHOD_LINE_RE);
      if (methodMatch) methods.push(methodMatch[1]);
    }
    if (methods.length > 0) operations.push({ path: match[1], methods });
  }
  return operations;
}

// Full auth contract for a YAML artifact (per-service YAML or the bundle),
// mirroring injectJson: top-level securitySchemes (API key, plus TrustReviewKey
// by path presence) + root API-key security + UnauthorizedError schema +
// per-operation 401 / public security:[] opt-outs / review-key stamping.
function injectYamlAuthContract(text) {
  const lines = text.split('\n');
  let changed = false;

  const operations = enumerateYamlOperations(lines);
  const hasTrustReview = operations.some(({ path }) => TRUST_REVIEW_KEY_PATHS.has(path));
  // Mirror injectJson: only inject UnauthorizedError when a non-public op
  // (which carries the 401 that references it) exists — otherwise it is orphaned.
  const hasNonPublicOp = operations.some(({ path }) => !PUBLIC_PATHS.has(path));

  changed = ensureYamlRootSecurity(lines) || changed;
  changed = ensureYamlSecuritySchemes(lines, hasTrustReview) || changed;
  if (hasNonPublicOp) changed = ensureYamlUnauthorizedSchema(lines) || changed;
  const staleForbidden = findYamlSchemaRange(lines, 'ForbiddenError');
  if (staleForbidden) {
    lines.splice(staleForbidden.start, staleForbidden.end - staleForbidden.start);
    changed = true;
  }

  for (const { path, methods } of operations) {
    for (const method of methods) {
      if (TRUST_REVIEW_KEY_PATHS.has(path)) {
        changed = ensureYamlOperationSecurity(lines, path, method, 'trust-review') || changed;
        changed = ensureYamlUnauthorizedResponse(lines, path, method, YAML_TRUST_REVIEW_UNAUTHORIZED_RESPONSE) || changed;
        changed = removeYamlForbiddenResponse(lines, path, method) || changed;
      } else if (PUBLIC_PATHS.has(path)) {
        // Public RPC: opt out of the root requirement, carry no 401. Drop any
        // stale 401 left over from when the path was authenticated.
        changed = ensureYamlOperationSecurity(lines, path, method, 'public') || changed;
        changed = removeYamlUnauthorizedResponse(lines, path, method) || changed;
        if (!PUBLIC_FORBIDDEN_GATES.has(path)) {
          changed = removeYamlForbiddenResponse(lines, path, method) || changed;
        }
      } else {
        changed = ensureYamlUnauthorizedResponse(lines, path, method) || changed;
        changed = removeYamlOperationSecurity(lines, path, method) || changed;
        changed = removeYamlForbiddenResponse(lines, path, method) || changed;
      }
    }
  }

  return { text: lines.join('\n'), changed };
}
// ── Run ──────────────────────────────────────────────────────────────────────
const specFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.json$/.test(f)).sort();
const serviceYamlFiles = readdirSync(apiDir).filter((f) => /Service\.openapi\.yaml$/.test(f)).sort();
let wouldChange = 0;
const touched = [];

for (const file of specFiles) {
  const path = resolve(apiDir, file);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (injectJson(spec)) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, serialize(spec));
  }
}

for (const file of serviceYamlFiles) {
  const path = resolve(apiDir, file);
  const raw = readFileSync(path, 'utf8');
  const authResult = injectYamlAuthContract(raw);
  const gateResult = injectYamlPublicGateContract(authResult.text);
  if (authResult.changed || gateResult.changed) {
    wouldChange++;
    touched.push(file);
    if (!CHECK) writeFileSync(path, gateResult.text);
  }
}

// Bundle (optional — only if present)
let bundleChanged = false;
try {
  const bundleRaw = readFileSync(bundlePath, 'utf8');
  const authResult = injectYamlAuthContract(bundleRaw);
  const gateResult = injectYamlPublicGateContract(authResult.text);
  bundleChanged = authResult.changed || gateResult.changed;
  if (bundleChanged) {
    wouldChange++;
    touched.push('worldmonitor.openapi.yaml');
    if (!CHECK) writeFileSync(bundlePath, gateResult.text);
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

if (CHECK) {
  if (wouldChange > 0) {
    console.error(`✗ ${wouldChange} OpenAPI artifact(s) missing the security contract: ${touched.join(', ')}`);
    console.error('  Run: npm run gen:openapi:security');
    process.exit(1);
  }
  console.log(`✓ all ${specFiles.length} JSON specs, ${serviceYamlFiles.length} YAML specs + bundle carry the security contract`);
} else {
  console.log(
    `openapi-inject-security: updated ${wouldChange} artifact(s) — ${specFiles.length} JSON specs, ${serviceYamlFiles.length} YAML specs scanned, bundle ${bundleChanged ? 'updated' : 'unchanged'}`,
  );
}
