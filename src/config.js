import { lstat, stat, readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, parse as parsePath, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { parse as parseTomlRaw, stringify } from 'smol-toml';

// Linked directories (Stow, dotfiles repos) are followed: writes land inside them and the link
// survives. A linked file is refused, since renaming over it would replace the link, and so is a
// dangling link on the way, which would only fail after other files were already written.
async function assertSafePath(path) {
  const full = resolve(path);
  let current = parsePath(full).root;
  for (const part of full.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isSymbolicLink()) continue;
    if (current === full) throw new Error(`Refusing symbolic link: ${current}`);
    await stat(current).catch(error => {
      throw error.code === 'ENOENT' ? new Error(`Refusing dangling symbolic link: ${current}`) : error;
    });
  }
}

export async function readConfig(path) {
  await assertSafePath(path);
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// smol-toml returns prototype-less tables, which isDeepStrictEqual never matches against the plain
// objects we compare them with. Rebuilding them as plain objects keeps `__proto__` an own key.
const plain = value => Array.isArray(value) ? value.map(plain)
  : value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)])) : value;
export const parseToml = text => plain(parseTomlRaw(text));

export function parseJson(text, path) {
  const errors = [];
  const value = parse(text ?? '{}', errors, { allowTrailingComma: true });
  if (errors.length || !object(value)) throw new Error(`Invalid JSON/JSONC object in ${path}; nothing overwritten.`);
  return value;
}

export function editJson(text, changes, path) {
  let next = text ?? '{}\n';
  for (const [keys, value] of changes) {
    let parent = parseJson(next, path);
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) break;
      if (!object(parent[key])) throw new Error(`Expected object at ${keys.join('.')} in ${path}`);
      parent = parent[key];
    }
    next = applyEdits(next, modify(next, keys, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: next.includes('\r\n') ? '\r\n' : '\n' },
    }));
  }
  parseJson(next, path);
  return next;
}

export function addToml(text, desired, path) {
  let existing;
  try { existing = parseToml(text ?? ''); }
  catch { throw new Error(`Invalid TOML in ${path}; nothing overwritten.`); }
  const missing = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!Object.hasOwn(existing, key)) missing[key] = value;
    else if (!isDeepStrictEqual(existing[key], value)) {
      throw new Error(`Conflicting ${key} in ${path}. Review it manually; nothing overwritten.`);
    }
  }
  if (!Object.keys(missing).length) return text ?? '';
  const scalars = Object.fromEntries(Object.entries(missing).filter(([, value]) => !object(value)));
  const tables = Object.fromEntries(Object.entries(missing).filter(([, value]) => object(value)));
  // Scalars must precede any existing table, but never rewrite what is already there:
  // joining trimmed blocks keeps the diff to the lines that were actually appended.
  const parts = [];
  if (Object.keys(scalars).length) parts.push(stringify(scalars));
  if ((text ?? '').trim()) parts.push(text);
  if (Object.keys(tables).length) parts.push(stringify(tables));
  const next = `${parts.map(part => part.replace(/\s+$/, '')).join('\n\n')}\n`;
  parseToml(next);
  return next;
}

// Update the dedicated Apex profile without reserializing unrelated settings or comments.
// Parse each complete statement, so multiline values and quoted/dotted keys are safe too.
export function updateToml(text, desired, path, obsolete = []) {
  const before = text ?? '';
  try { parseToml(before); }
  catch { throw new Error(`Invalid TOML in ${path}; nothing overwritten.`); }
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const keyText = key => /^[\w-]+$/.test(key) ? key : JSON.stringify(key);
  const lines = before.split(/\r?\n/);
  const valueAt = (value, keys) => keys.reduce((parent, key) => parent?.[key], value);
  const merge = (old, next) => object(next)
    ? Object.fromEntries(Object.entries({ ...(object(old) ? old : {}), ...next }).map(([key, value]) =>
      [key, Object.hasOwn(next, key) ? merge(old?.[key], next[key]) : value])) : next;
  const inline = value => value instanceof Date ? stringify({ value }).trim().replace(/^value\s*=\s*/, '') : object(value)
    ? `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${inline(item)}`).join(', ')} }`
    : Array.isArray(value) ? `[${value.map(inline).join(', ')}]`
      : stringify({ value }).trim().replace(/^value\s*=\s*/, '');
  const statements = [];
  let section = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim() || lines[i].trimStart().startsWith('#')) {
      statements.push({ text: lines[i], section });
      continue;
    }
    let block = lines[i], parsed;
    for (;;) {
      try { parsed = parseToml(block); break; }
      catch {
        if (++i >= lines.length) throw new Error(`Cannot safely update TOML in ${path}.`);
        block += eol + lines[i];
      }
    }
    if (block.trimStart().startsWith('[')) {
      // Array tables are unrelated to the owned scalar settings and are left alone.
      section = [];
      let cursor = parsed;
      while (object(cursor) && Object.keys(cursor).length === 1) {
        const key = Object.keys(cursor)[0]; section.push(key); cursor = cursor[key];
      }
      statements.push({ text: block, section, header: true, array: Array.isArray(cursor) });
      continue;
    }
    let equal = 0, keyQuote = null;
    for (; equal < block.length; equal++) {
      const char = block[equal];
      if (keyQuote === '"' && char === '\\') { equal++; continue; }
      if (keyQuote) { if (char === keyQuote) keyQuote = null; }
      else if (char === '"' || char === "'") keyQuote = char;
      else if (char === '=') break;
    }
    const rawKey = block.slice(0, equal).trim();
    let cursor = parseToml(`${rawKey} = 0`), keys = [];
    while (object(cursor)) { const key = Object.keys(cursor)[0]; keys.push(key); cursor = cursor[key]; }
    const full = [...section, ...keys];
    if (obsolete.includes(full.join('.'))) continue;
    const next = valueAt(desired, full);
    if (next !== undefined && !isDeepStrictEqual(valueAt(parsed, keys), merge(valueAt(parsed, keys), next))) {
      // Preserve a trailing comment on ordinary single-line values.
      let comment = '', quote = null;
      if (!block.includes(eol)) for (let j = equal + 1; j < block.length; j++) {
        const char = block[j];
        if (quote === '"' && char === '\\') { j++; continue; }
        if (quote) { if (char === quote) quote = null; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '#') { comment = ` ${block.slice(j)}`; break; }
      }
      block = `${block.slice(0, equal + 1)} ${inline(merge(valueAt(parsed, keys), next))}${comment}`;
    }
    statements.push({ text: block, section });
  }
  const leaves = (value, prefix = []) => Object.entries(value).flatMap(([key, item]) =>
    object(item) ? leaves(item, [...prefix, key]) : [[ [...prefix, key], item ]]);
  for (const [keys, value] of leaves(desired)) {
    const current = parseToml(statements.map(item => item.text).join(eol));
    if (isDeepStrictEqual(valueAt(current, keys), value)) continue;
    let header = -1, prefix = [];
    statements.forEach((item, index) => {
      if (item.header && !item.array && item.section.length < keys.length
        && item.section.every((key, i) => key === keys[i]) && item.section.length > prefix.length) {
        header = index; prefix = item.section;
      }
    });
    let end = statements.findIndex((item, index) => index > header && item.header);
    if (end === -1) end = statements.length;
    statements.splice(end, 0, { text: `${keys.slice(prefix.length).map(keyText).join('.')} = ${inline(value)}`, section: prefix });
  }
  const after = statements.map(item => item.text).join(eol);
  const result = parseToml(after);
  for (const [keys, value] of leaves(desired)) {
    if (!isDeepStrictEqual(valueAt(result, keys), value)) throw new Error(`Cannot safely update ${keys.join('.')} in ${path}.`);
  }
  return after === before ? before : `${after.replace(/\s+$/, '')}${eol}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// A private file written beside the target and renamed over it, so nobody ever reads half of it.
// `check` runs last, right before the rename, and can still call the write off.
export async function writeAtomic(path, text, check = async () => {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.apex-tmp-${randomUUID().slice(0, 8)}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await check();
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function removeChange(change) {
  const { path, before } = change;
  if (await readConfig(path) !== before) throw new Error(`Configuration changed while planning: ${path}. Run undo again.`);
  await unlink(path);
}

export async function writeChange(change) {
  const { path, before, after } = change;
  // readConfig refuses a symlinked file or a dangling link, so this check also guards the write.
  if (await readConfig(path) !== before) throw new Error(`Configuration changed while planning: ${path}. Run init again.`);
  const backup = before === null ? null : `${path}.apex-backup-${randomUUID().slice(0, 8)}`;
  if (backup) {
    const handle = await open(backup, 'wx', 0o600);
    try { await handle.writeFile(before); } finally { await handle.close(); }
  }
  await writeAtomic(path, after, async () => {
    if (await readConfig(path) !== before) throw new Error(`Configuration changed before saving: ${path}`);
  });
  return backup;
}
