import { styleText } from 'node:util';
import * as p from '@clack/prompts';
import { PROVIDERS } from './assistants.js';
import { formatValue } from './diff.js';
import { REDACTED, isEnvReference, maskValue } from './secrets.js';
import { shortPath } from './paths.js';
import { interactive } from './tty.js';

const green = text => styleText('green', text);
const red = text => styleText('red', text);
const yellow = text => styleText('yellow', text);
const magenta = text => styleText('magenta', text);
const gray = text => styleText('gray', text);
const dim = text => styleText('dim', text);
const bold = text => styleText('bold', text);
const underline = text => styleText('underline', text);
const link = text => styleText(['blue', 'underline'], text);

if (!interactive()) p.settings.withGuide = false;
const columns = () => process.stdout.columns || Number(process.env.COLUMNS) || 88;
export const width = () => Math.min(columns(), 96);

// clack draws its prompts with the border at column 0 and the text at column 3 (`◇  …`, `│  …`).
// Everything Apex prints uses that same 3-space gutter, so a picker, a plan and a diff below it
// all read as one column instead of two competing indents.
const GUTTER = '   ';
// Widths are always measured on the visible text, so colour can never push a line over the edge.
const visible = text => text.replace(/\u001b\[[0-9;]*m/g, '');

// A URL must stay whole to remain openable; anything else that cannot fit is cut, because the
// alternative is the terminal breaking the line at column 0 for us.
const unbreakable = word => /^[a-z][a-z0-9+.-]*:\/\//i.test(word);

function pieces(text, limit) {
  return text.split(' ').flatMap(word =>
    unbreakable(word) || visible(word).length <= limit
      ? [word]
      : word.match(new RegExp(`.{1,${limit}}`, 'g'),));
}

function wrap(text, limit) {
  if (visible(text).length <= limit) return [text];
  const lines = [];
  // `null` rather than '' marks an empty line, so the pieces of a leading indent are kept.
  let line = null;
  for (const word of pieces(text, limit)) {
    if (line !== null && visible(`${line} ${word}`).length > limit) { lines.push(line); line = word; }
    else line = line === null ? word : `${line} ${word}`;
  }
  if (line !== null) lines.push(line);
  return lines;
}

function displayValue(key, value, secret) {
  const safe = maskValue(key, value, secret);
  if (safe === REDACTED) return { text: safe, color: yellow };
  if (isEnvReference(safe)) return { text: String(safe), color: magenta };
  return { text: formatValue(safe), color: text => text };
}

const OP = {
  add: { mark: '+', color: green },
  replace: { mark: '~', color: yellow },
  remove: { mark: '-', color: red },
};

const STATUS = {
  create: { word: 'Create', color: green },
  update: { word: 'Update', color: green },
  unchanged: { word: 'Unchanged', color: gray },
  restore: { word: 'Restore', color: yellow },
  remove: { word: 'Delete', color: red },
};

// Two columns may never touch: a column is its longest value plus a gap, and `pad` refuses to
// shrink below that, so no label can glue itself to the next column however long it is.
export const columnWidth = (values, gap = 2) => Math.max(...values.map(value => visible(String(value)).length), 0) + gap;
export const pad = (text, column) => {
  const value = String(text);
  // padEnd would count the escape codes as content, so a coloured label silently steals the gap
  // from the next column.
  return value + ' '.repeat(Math.max(1, column - visible(value).length));
};

// The model id (one per gateway) is the one string worth colouring everywhere it appears. Green
// alone is enough: its reset (39) clears the colour but leaves the caller's bold or dim (22) running. Occurrences inside
// a longer token are left alone, so a URL or a `provider/model` string is never broken mid-string.
const MODELS = [...new Set(Object.values(PROVIDERS).map(provider => provider.model))]
  .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const MODEL_PATTERN = new RegExp(`(?<![\\w/.-])(?:${MODELS.join('|')})(?![\\w-])`, 'g');
export const model = text => String(text).replace(MODEL_PATTERN, match => green(match));

const STATUS_COLUMN = columnWidth(Object.values(STATUS).map(status => status.word));

// Text that cannot fit is shortened in the middle rather than left to the terminal: the tail of a
// path is what identifies it, and a hard-wrapped line would fall out of the gutter.
export function clip(text, limit) {
  const visibleText = visible(text);
  if (visibleText.length <= limit) return text;
  const head = Math.max(Math.ceil((limit - 1) / 2), 1);
  const tail = Math.max(limit - 1 - head, 1);
  return `${visibleText.slice(0, head)}\u2026${visibleText.slice(-tail)}`;
}

function changeLines(changes, secret, limit) {
  // Keep at least a short value column on narrow terminals by shrinking the key column first.
  const keyWidth = Math.min(columnWidth(changes.map(change => change.key)), 45,
    Math.max(17, limit - GUTTER.length - 3 - 20));
  const rows = [];
  for (const change of changes) {
    const op = OP[change.op];
    const key = change.key.length > keyWidth ? `${change.key.slice(0, keyWidth - 1)}…` : change.key;
    const prefix = `${op.color(op.mark)} ${dim(model(pad(key, keyWidth)))}`;
    if (change.op === 'replace') {
      const from = displayValue(change.key, change.oldValue, secret);
      const to = displayValue(change.key, change.value, secret);
      rows.push(prefix + dim(model(from.text)) + yellow(' → ') + to.color(model(to.text)));
      continue;
    }
    const value = displayValue(change.key, change.value, secret);
    const [first, ...rest] = wrap(value.text, Math.max(limit - GUTTER.length - 3 - keyWidth, 20));
    rows.push(prefix + value.color(model(first ?? '')));
    for (const line of rest) rows.push(dim(' '.repeat(2)) + ' '.repeat(keyWidth) + value.color(model(line)));
  }
  return rows;
}

const DIFF_MARKS = ['+', '-', '@'];

function fileBlock(file, { secret }) {
  const status = STATUS[file.status];
  const limit = width() - GUTTER.length;
  const path = clip(shortPath(file.path), limit - STATUS_COLUMN);
  const lines = [`${status.color(pad(status.word, STATUS_COLUMN))}${bold(path)}`];
  if (file.diff?.length) {
    // The diff is the change list; repeating it as key/value rows is just noise. A line wider than
    // the terminal is folded and keeps its marker, so it never reads as an unchanged context line.
    for (const line of file.diff) {
      const mark = DIFF_MARKS.includes(line[0]) ? line[0] : ' ';
      const color = mark === '+' ? green : mark === '-' ? red : mark === '@' ? magenta : dim;
      const [first, ...rest] = wrap(line, limit);
      lines.push(color(first));
      for (const folded of rest) lines.push(color(mark === '@' ? ` ${folded}` : `${mark}${folded}`));
    }
    return lines;
  }
  const shown = file.changes.slice(0, 12);
  lines.push(...changeLines(shown, secret, width()));
  if (file.changes.length > shown.length) lines.push(dim(`… ${file.changes.length - shown.length} more`));
  return lines;
}

// Layering: `write` is the only stdout call, `plain` owns the gutter, `heading` owns the air above
// a block, `bullet` owns hanging continuation, and `box` draws the one bordered element. The rule
// for callers is that a heading fills its own gap, so nothing blanks a line before a heading;
// separators between a heading's own rows stay explicit at the call site.
const SECTION_GAP = 2;

const write = text => process.stdout.write(`${text}\n`);

export function plain(text = '') {
  write(text === '' ? '' : `${GUTTER}${text}`);
}

// A prose row wraps inside the gutter; `plain` stays raw so preformatted columns are never touched.
export function prose(text) {
  for (const line of wrap(text, width() - GUTTER.length)) plain(line);
}

function heading(text, gap = SECTION_GAP) {
  for (let index = 0; index < gap; index += 1) write('');
  for (const line of wrap(text, width() - GUTTER.length)) plain(bold(model(line)));
}

export function renderPlan(title, files, options = {}) {
  const pending = files.some(file => file.status !== 'unchanged');
  heading(pending ? `${title}:` : `${title}: nothing to change`);
  plain('');
  for (const [index, file] of files.entries()) {
    for (const line of fileBlock(file, options)) plain(line);
    if (index < files.length - 1) plain('');
  }
}

export function section(title, lines) {
  heading(title);
  plain('');
  for (const line of lines) {
    for (const wrapped of wrap(line, width() - GUTTER.length)) plain(model(wrapped));
  }
}

// The one place with a border, drawn by hand so the right edge always lines up: widths are
// measured on the visible text, and the border sits just outside the gutter, so text in the box
// starts in the same column as every other line.
function box(lines) {
  const left = ' '.repeat(GUTTER.length - 2);
  const inner = Math.max(...lines.map(line => visible(line).length));
  const edge = '\u2500'.repeat(inner + 2);
  write(`${left}\u250c${edge}\u2510`);
  for (const line of lines) write(`${left}\u2502 ${line}${' '.repeat(inner - visible(line).length)} \u2502`);
  write(`${left}\u2514${edge}\u2518`);
}

export function intro(title, subtitle) {
  const inner = Math.max(24, width() - GUTTER.length - 4);
  const lines = wrap(title, inner).map(line => bold(model(line)));
  if (subtitle) lines.push('', ...wrap(subtitle, inner).map(line => dim(line)));
  box(lines);
}

export const outro = message => heading(message, 1);

// Status rows are prose too: they wrap inside the gutter and line their continuation up under the
// text, so a long explanation cannot push a second line back out to column 0.
const MARK_WIDTH = 2;
function bullet(marker, message) {
  const lines = wrap(message, width() - GUTTER.length - MARK_WIDTH);
  lines.forEach((line, index) => {
    const mark = index === 0 ? `${marker}${' '.repeat(Math.max(MARK_WIDTH - visible(marker).length, 1))}` : ' '.repeat(MARK_WIDTH);
    plain(`${mark}${line}`);
  });
}

export const success = message => bullet(green('✔'), message);
export const warn = message => bullet(yellow('!'), message);
export const error = message => bullet(red('✖'), message);

export async function selectProvider(options, initial) {
  const chosen = await p.select({ message: 'Which gateway should your assistants use for Apex?', options, initialValue: initial });
  if (p.isCancel(chosen)) { p.cancel('Cancelled. Nothing was written.'); return false; }
  return chosen;
}

export async function selectAssistants(options, initial, modelId) {
  const chosen = await p.multiselect({
    message: model(`Set up ${modelId} for which assistants?  ${dim('(space toggles, enter confirms)')}`),
    options,
    initialValues: initial,
    required: false,
    maxItems: 8,
  });
  if (p.isCancel(chosen)) { p.cancel('Cancelled. Nothing was written.'); return false; }
  return chosen;
}

export async function confirmApply(question, hint) {
  // clack measures prompt messages narrowly, so the dim hint gets its own line above the question.
  if (hint) { plain(''); plain(dim(hint)); }
  const answer = await p.confirm({ message: question, initialValue: false });
  if (p.isCancel(answer)) { p.cancel('Cancelled. Nothing was written.'); return false; }
  if (!answer) warn('Cancelled. Nothing was written.');
  return answer;
}

// A yes/no question outside the apply flow; cancelling it simply means no.
export async function ask(question) {
  plain('');
  const answer = await p.confirm({ message: question, initialValue: true });
  return answer === true;
}

export { green, yellow, gray, dim, bold, underline, link };
export { wrap };
