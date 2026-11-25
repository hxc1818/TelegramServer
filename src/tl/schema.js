// Minimal parser for Telegram TL schema files (no dependencies).
// Handles `---types---` / `---functions---`, `//` comments, explicit `#id`s,
// `flags:#` / `flags.N?Type` parameters, generic `!X` / `X` types, and the
// trailing `// LAYER N` marker used by the TDesktop schema dump.

import { readFileSync } from 'node:fs';

// ---- CRC32 (IEEE, reflected) ------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(text) {
  let c = 0xffffffff;
  const bytes = Buffer.from(String(text), 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Normalize a TL declaration before hashing it:
 *   - strip comments
 *   - drop the trailing `;`
 *   - collapse whitespace to single spaces
 *   - remove spaces around parentheses / brackets / braces
 */
export function normalizeDecl(decl) {
  let s = String(decl).replace(/\/\/.*$/, '').trim();
  if (s.endsWith(';')) s = s.slice(0, -1);
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/\s*([()[\]{}])\s*/g, '$1');
  return s.trim();
}

/** Explicit `#id` always wins; otherwise CRC32 of the normalized declaration. */
export function constructorId(decl) {
  const s = String(decl).replace(/\/\/.*$/, '').trim();
  const explicit = s.match(/#([0-9a-fA-F]{1,8})(?![0-9a-fA-F])/);
  if (explicit) return parseInt(explicit[1], 16) >>> 0;
  return crc32(normalizeDecl(s));
}

// ---- declaration parsing ----------------------------------------------

function parseParams(rest) {
  if (!rest) return [];
  // `[ t ]` is a single TL token; keep it together before splitting.
  const tokens = rest
    .replace(/\[\s+([^\]]+?)\s+\]/g, '[$1]')
    .split(/\s+/)
    .filter(Boolean);
  const params = [];
  for (const token of tokens) {
    if (token.startsWith('{') || token.endsWith('}') || token === '#') continue;
    const colon = token.indexOf(':');
    if (colon <= 0) continue;
    const name = token.slice(0, colon);
    let type = token.slice(colon + 1);
    const flag = type.match(/^([A-Za-z_]\w*)\.(\d+)\?(.+)$/);
    if (flag) {
      params.push({ name, type: flag[3], flagBit: Number(flag[2]) });
    } else {
      params.push({ name, type });
    }
  }
  return params;
}

/**
 * Parse TL schema text into:
 *   { types: Map<name, entry>, functions: Map<name, entry>, layer: number|null }
 * where entry = { id, name, params: [{name, type, flagBit?}], result }.
 */
export function parseSchema(text) {
  const types = new Map();
  const functions = new Map();
  let layer = null;
  let section = 'types';

  for (const rawLine of String(text).split(/\r?\n/)) {
    const layerMatch = rawLine.match(/\/\/\s*LAYER\s+(\d+)/i);
    if (layerMatch) {
      layer = Number(layerMatch[1]);
      continue;
    }

    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line === '---types---') { section = 'types'; continue; }
    if (line === '---functions---') { section = 'functions'; continue; }
    if (line.startsWith('---')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const left = line.slice(0, eq).trim();
    const result = line.slice(eq + 1).trim().replace(/;$/, '').trim();
    const head = left.match(/^([A-Za-z_][\w.]*)(?:#[0-9a-fA-F]{1,8})?(?=\s|$)/);
    if (!head) continue;

    const name = head[1];
    const entry = {
      id: constructorId(line),
      name,
      params: parseParams(left.slice(head[0].length).trim()),
      result,
    };
    (section === 'functions' ? functions : types).set(name, entry);
  }

  return { types, functions, layer };
}

// ---- pinned schema loader ---------------------------------------------

let cached = null;

/** Read + parse schema/api.tl and schema/mtproto.tl from the repo root (cached). */
export function loadSchema() {
  if (cached) return cached;
  const root = new URL('../../', import.meta.url);
  const api = readFileSync(new URL('schema/api.tl', root), 'utf8');
  const mtproto = readFileSync(new URL('schema/mtproto.tl', root), 'utf8');
  cached = parseSchema(`${api}\n${mtproto}`);
  return cached;
}
