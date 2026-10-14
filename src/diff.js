import { isDeepStrictEqual } from 'node:util';
import { parseJson, parseToml } from './config.js';
import { redactText } from './secrets.js';

function readValues(text, format) {
  if (format === 'toml') {
    try { return parseToml(text); }
    catch { throw new Error('Invalid TOML while reading values.'); }
  }
  return parseJson(text, 'values');
}

function* leaves(value, prefix = []) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) yield* leaves(child, [...prefix, key]);
  } else {
    yield [prefix.join('.'), value];
  }
}

export function diffValues({ before, after, format = 'json' }) {
  const previous = before === null ? {} : readValues(before, format);
  const next = after === null ? {} : readValues(after, format);
  const oldKeys = new Map(leaves(previous));
  const newKeys = new Map(leaves(next));
  const changes = [];
  for (const [key, value] of newKeys) {
    if (!oldKeys.has(key)) changes.push({ op: 'add', key, value });
    else if (!isDeepStrictEqual(oldKeys.get(key), value)) changes.push({ op: 'replace', key, value, oldValue: oldKeys.get(key) });
  }
  for (const [key, value] of oldKeys) if (!newKeys.has(key)) changes.push({ op: 'remove', key, value });
  return changes;
}

export function formatValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'object') {
    const inner = Array.isArray(value)
      ? value.map(formatValue).join(', ')
      : Object.entries(value).map(([key, child]) => `${key}: ${formatValue(child)}`).join(', ');
    return Array.isArray(value) ? `[ ${inner} ]` : `{ ${inner} }`;
  }
  return String(value);
}

// A missing file has no lines at all, which is what makes both sides of the diff symmetric:
// a created file diffs against /dev/null and a deleted one diffs to /dev/null.
function toLines(text) {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  return lines.length > 1 && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

// Longest-common-subsequence diff: keeps hunks to the lines that really moved,
// so inserting one key never renders the whole file as changed. Each op points at its line: new
// lines for `+`, old lines otherwise.
function align(oldLines, newLines) {
  if (oldLines.length * newLines.length > 250_000) return null;
  const rows = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      rows[i][j] = oldLines[i] === newLines[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) { ops.push([' ', i]); i += 1; j += 1; }
    else if (rows[i + 1][j] >= rows[i][j + 1]) { ops.push(['-', i]); i += 1; }
    else { ops.push(['+', j]); j += 1; }
  }
  while (i < oldLines.length) ops.push(['-', i++]);
  while (j < newLines.length) ops.push(['+', j++]);
  return ops;
}

export function unifiedDiff(path, before, after, secret) {
  const oldLines = toLines(before);
  const newLines = toLines(after);
  // Configs are tens of lines; if one ever outgrew the exact diff, replacing the whole file is
  // coarse but honest, where an approximate alignment would invent lines that did not move.
  const ops = align(oldLines, newLines)
    ?? [...oldLines.map((_, index) => ['-', index]), ...newLines.map((_, index) => ['+', index])];
  if (ops.every(([mark]) => mark === ' ')) return [];

  const CONTEXT = 3;
  const changed = ops.map(([mark], index) => (mark === ' ' ? -1 : index)).filter(index => index >= 0);
  const hunks = [];
  for (const index of changed) {
    const last = hunks.at(-1);
    if (last && index - last.end <= CONTEXT * 2) last.end = index;
    else hunks.push({ start: index, end: index });
  }
  const prefix = [{ old: 0, new: 0 }];
  for (const [index, [mark]] of ops.entries()) {
    const prev = prefix[index];
    prefix.push({ old: prev.old + (mark !== '+'), new: prev.new + (mark !== '-') });
  }
  // Only file contents are redacted: path headers and @@ ranges carry no credential, and masking
  // them would mangle the very paths the diff is showing. Each side is redacted whole, so a secret
  // list spread over several lines is caught, and redaction never adds or removes a line.
  const shown = text => toLines(text === null ? null : redactText(text, secret));
  const [oldShown, newShown] = [shown(before), shown(after)];
  const body = ops.map(([mark, index]) => `${mark}${(mark === '+' ? newShown : oldShown)[index]}`);
  const lines = [`--- ${before === null ? '/dev/null' : path}`, `+++ ${after === null ? '/dev/null' : path}`];
  for (const hunk of hunks) {
    const from = Math.max(0, hunk.start - CONTEXT);
    const to = Math.min(ops.length, hunk.end + 1 + CONTEXT);
    const oldCount = prefix[to].old - prefix[from].old;
    const newCount = prefix[to].new - prefix[from].new;
    // Empty side of a hunk starts at 0, matching git's @@ headers.
    const oldStart = oldCount ? prefix[from].old + 1 : 0;
    const newStart = newCount ? prefix[from].new + 1 : 0;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body.slice(from, to));
  }
  return lines;
}
