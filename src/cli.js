#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IDS, MANUAL_IDS, NAMES, PROVIDERS, PROVIDER_IDS, RUNNABLE, defaultProvider, detect, executable, launchOptions, launchToken, manualSteps, openCodeMajor, planAssistant, runExpansion } from './assistants.js';
import { removeChange, writeChange } from './config.js';
import { MODE_NOTE, describeFile, resolveMode, runWrites } from './plan.js';
import { appendEntry, batchIds, journalPath, markUndone, newEntry, planUndo, readJournal } from './journal.js';
import { maskChanges } from './secrets.js';
import { shortPath } from './paths.js';
import { interactive } from './tty.js';
import * as ui from './ui.js';

// One table for the whole command surface: flag parsing, --help and the completion scripts are
// all generated from it, so none of the three can promise a flag the others reject.
const FLAGS = {
  assistants: { type: 'string', usage: '--assistants <ids>', hint: 'assistant ids',
    text: `comma list of: ${IDS.join(', ')} (skips the picker)` },
  provider: { type: 'string', usage: '--provider <id>', hint: 'gateway serving Apex',
    text: `${PROVIDER_IDS.join(' or ')}; defaults to the one whose key is set, else vercel (skips the question)` },
  'no-interactive': { type: 'boolean', usage: '--no-interactive', hint: 'never prompt',
    text: 'skip the questions and just print the plan' },
  apply: { type: 'boolean', usage: '--apply', hint: 'write without prompting',
    text: 'write changes without prompting (scripts and CI)' },
  'no-diff': { type: 'boolean', usage: '--no-diff', hint: 'list settings instead of the file diff',
    text: 'hide the raw file diff (it is shown by default, secrets redacted)' },
  json: { type: 'boolean', usage: '--json', hint: 'machine-readable output',
    text: 'print machine-readable output instead of the human UI' },
  list: { type: 'boolean', usage: '--list', hint: 'list recorded setups',
    text: 'show recorded setups instead of reverting one' },
  help: { type: 'boolean', short: 'h', usage: '--help, -h', hint: 'show help',
    text: 'show all commands' },
};

const COMMANDS = {
  init: { args: '[--assistants <ids>] [options]', summary: 'configure assistants',
    flags: ['assistants', 'provider', 'no-interactive', 'apply', 'no-diff', 'json', 'help'] },
  detect: { args: '[--provider <id>] [--json]', summary: 'show what Apex CLI can see on this machine',
    flags: ['provider', 'json', 'help'] },
  undo: { args: '[--list] [options]', summary: 'reverse the most recent Apex CLI setup',
    flags: ['no-interactive', 'apply', 'no-diff', 'json', 'list', 'help'] },
  run: { args: `[--provider <id>] <${RUNNABLE.join('|')}> [-- <args>]`, summary: 'launch an assistant with the gateway set',
    flags: [] },
  completion: { args: '<zsh|bash|fish>', summary: 'print a shell completion script', flags: [] },
  help: { args: '', summary: 'show all commands', flags: [] },
};

const SHELLS = ['zsh', 'bash', 'fish'];
// Started through npx, there is no `apex` on PATH afterwards, so every command Apex CLI tells you
// to run next is spelled the way this run was started.
const APEX = process.env.npm_command === 'exec' ? 'npx @callstack/apex' : 'apex';
const packageVersion = async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;

// An npx run leaves nothing behind, yet undo and run are for later, so an interactive npx run
// offers to keep the exact version that just ran. Returns whether `apex` is now installed.
async function installApex() {
  if (!await ui.ask('Install the apex command globally, so apex undo and apex run work later?')) return false;
  const npm = spawn('npm', ['install', '--global', `@callstack/apex@${await packageVersion()}`], {
    // npm's own errors (EACCES and the like) are the useful part; its progress output is not.
    stdio: ['ignore', 'ignore', 'inherit'],
    // npm is a .cmd shim on Windows, which only runs through a shell; the arguments are fixed.
    shell: process.platform === 'win32',
  });
  const code = await new Promise(resolve => { npm.once('error', () => resolve(1)); npm.once('exit', resolve); });
  if (code === 0) ui.success('Installed. From now on, just type apex.');
  else ui.warn('npm could not install it. Run npm install -g @callstack/apex yourself.');
  return code === 0;
}
const OPTIONS = Object.fromEntries(Object.entries(FLAGS).map(([name, flag]) =>
  [name, { type: flag.type, ...(flag.short ? { short: flag.short } : {}) }]));
const flagsOf = command => COMMANDS[command].flags;
const commandsFor = flag => Object.keys(COMMANDS).filter(name => COMMANDS[name].flags.includes(flag));

const usageRows = Object.entries(COMMANDS).map(([name, command]) =>
  [`apex ${name}${command.args ? ` ${command.args}` : ''}`, command.summary]);
// The no-flag default is an option row like any other, so it cannot drift out of the table either.
const optionRows = [['(no flags)', '(init, undo)',
  'interactive: pick assistants, review every change and diff, then confirm'],
  ...Object.entries(FLAGS).map(([name, flag]) => [flag.usage, `(${commandsFor(name).join(', ')})`, flag.text])];
const exampleRows = [
  ['apex init', 'pick assistants, review, confirm'],
  ['apex init --assistants codex,pi', 'preview two tools (agent and CI friendly)'],
  ['apex init --assistants codex,pi --apply', 'write those two without asking'],
  ['apex init --provider callstack', 'use the Callstack portal instead of Vercel AI Gateway'],
  ['apex undo', 'preview the reversal'],
  ['apex undo --apply', 'reverse the last setup without asking'],
  ['apex detect --json', 'machine-readable inventory'],
];
// Names in the left column, values on the right: a wall of four variable names is not a column.
const environmentRows = [
  ...Object.values(PROVIDERS).map(provider => [provider.envVar,
    `${provider.keyName}, needed by apex run and by every assistant you configure for ${provider.name}`]),
  ['Config directories', 'XDG_CONFIG_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR'],
  ['Undo journal', 'APEX_STATE_DIR, XDG_STATE_HOME (default ~/.local/state/apex)'],
];
const installRows = [
  ['zsh', 'apex completion zsh  > "${fpath[1]}/_apex"'],
  ['bash', 'apex completion bash >> ~/.bashrc'],
  ['fish', 'apex completion fish > ~/.config/fish/completions/apex.fish'],
];

const INDENT = '  ';
// A description with less room than this is unreadable, so it moves to its own line.
const MIN_TEXT = 24;

const helpHeading = text => ui.bold(ui.underline(text));
const PLAIN = text => text;
const rowColors = (lead, scope = PLAIN, text = PLAIN) => ({ lead, scope, text });
// Only real flags are green: `(no flags)` is a description of a case, not something to type.
const optionColors = rowColors(
  text => (text.startsWith('--') ? ui.green(text) : ui.dim(text)), ui.dim, PLAIN);
// Every command line reads the same way: `apex` green, the command plain, whatever follows dim.
// A command that wraps keeps colouring by position: only its first line starts with `apex`.
const commandLine = (line, index = 0) => (index ? ui.dim(line)
  : line.replace(/^(apex)( \S+)?(.*)$/, (_, apex, command = '', rest) => ui.green(apex) + command + (rest && ui.dim(rest))));

// Three columns: what you type, who accepts it, what it does. Column widths are measured on plain
// text and colour goes on when a line is emitted.
function columnRows(rows, color, width) {
  // A column that eats half the terminal leaves nothing to read, so a lead longer than this moves
  // its own text below it while the rest of the rows keep the shared column.
  const leadWidth = Math.min(ui.columnWidth(rows.map(([lead]) => lead)), Math.floor(width / 2) - INDENT.length);
  // An absent scope column must not leave a gap either: only rows that have one widen it.
  const scopeWidth = rows.some(([, scope]) => scope) ? ui.columnWidth(rows.map(([, scope]) => scope)) : 0;
  const textCol = INDENT.length + leadWidth + scopeWidth;
  const stacked = width - textCol < MIN_TEXT;
  const lines = [];
  for (const [lead, scope, text] of rows) {
    const head = `${INDENT}${ui.pad(color.lead(lead), leadWidth)}${scope ? ui.pad(color.scope(scope), scopeWidth) : ''}`;
    if (stacked || lead.length + 1 > leadWidth) {
      const leadLines = ui.wrap(lead, width - INDENT.length);
      leadLines.forEach((part, index) => lines.push(`${INDENT}${color.lead(part, index)}${
        index === leadLines.length - 1 && scope ? ` ${color.scope(scope)}` : ''}`));
      const below = `${INDENT}    `;
      for (const line of ui.wrap(text, width - below.length).map(color.text)) lines.push(below + line);
      continue;
    }
    const [first, ...rest] = ui.wrap(text, width - textCol).map(color.text);
    lines.push((head + first).replace(/\s+$/, ''));
    for (const line of rest) lines.push(' '.repeat(textCol) + line);
  }
  return lines;
}

// Rendered on demand: the colour and the column widths belong to the terminal that asked.
function helpText() {
  const width = ui.width();
  const section = (title, rows, color) => [helpHeading(title), ...columnRows(rows, color, width), ''];
  return [
    ...ui.wrap(`Apex CLI: point your coding assistants at Apex via ${Object.values(PROVIDERS).map(provider => provider.name).join(' or the ')}`, width).map(line => ui.bold(ui.model(line))),
    '',
    ...section('Usage', usageRows.map(([lead, text]) => [lead, '', text]), rowColors(commandLine)),
    ...section('Options', optionRows, optionColors),
    ...section('Examples', exampleRows.map(([lead, text]) => [lead, '', text]), rowColors(commandLine, PLAIN, ui.dim)),
    ...section('Environment', environmentRows.map(([lead, text]) => [lead, '', text]), rowColors(ui.yellow, PLAIN, PLAIN)),
    ...section('Install completions', installRows.map(([lead, text]) => [lead, '', text]), rowColors(PLAIN, PLAIN, commandLine)),
    ...ui.wrap('Restart the shell afterwards, or rehash zsh and re-source your bashrc.', width - INDENT.length)
      .map(line => `${INDENT}${ui.dim(line)}`),
    '',
    ...ui.wrap('Node.js 22+ required. Codex profiles target 0.134.0+', width).map(line => ui.dim(line)),
  ].join('\n');
}

const printHelp = () => console.log(helpText());

function readFlags(rest, command) {
  const { values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false });
  const unsupported = Object.keys(values).filter(name => !flagsOf(command).includes(name));
  if (unsupported.length) throw new Error(`--${unsupported[0]} is not valid for apex ${command}. See ${APEX} --help.`);
  const selected = values.assistants === undefined ? null : [...new Set(values.assistants.split(',').map(id => id.trim()))];
  if (selected?.includes('')) throw new Error('--assistants needs at least one id.');
  if (selected?.some(id => !IDS.includes(id))) throw new Error(`Unknown assistant in --assistants. Choose from: ${IDS.join(', ')}`);
  if (values.provider !== undefined && !PROVIDER_IDS.includes(values.provider)) {
    throw new Error(`Unknown --provider. Choose from: ${PROVIDER_IDS.join(', ')}`);
  }
  const json = Boolean(values.json);
  return {
    selected,
    provider: values.provider === undefined ? null : PROVIDERS[values.provider],
    showDiff: !values['no-diff'],
    json,
    help: Boolean(values.help),
    list: Boolean(values.list),
    mode: resolveMode({
      apply: Boolean(values.apply),
      nonInteractive: Boolean(values['no-interactive'] || json),
    }),
  };
}

async function planAll(assistants, options, provider) {
  return Promise.all(assistants.map(async assistant => {
    const base = {
      id: assistant.id,
      name: NAMES[assistant.id],
      detected: assistant.detected,
      evidence: assistant.evidence || null,
      binary: assistant.binary ?? null,
      manual: MANUAL_IDS.includes(assistant.id),
      error: null,
      files: [],
      steps: [],
    };
    try {
      base.files = (await planAssistant(assistant, provider)).map(change => describeFile(change, options));
      base.steps = base.files.flatMap(file => file.change.steps ?? []);
    } catch (error) {
      base.error = error.message;
    }
    return base;
  }));
}

const token = provider => process.env[provider.envVar]?.trim() || undefined;

// Journal timestamps are ISO for machines; people just want to recognise the run.
const stamp = iso => iso.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

const pendingOf = entry => entry.files.filter(file => file.status !== 'unchanged');

// A batch that fails halfway has still moved files on disk, so --json reports every path that
// landed together with the error, rather than nothing at all.
async function applyAll(items, apply) {
  const applied = [];
  try { for (const item of items) applied.push(await apply(item)); }
  catch (error) { return { applied, failure: error }; }
  return { applied, failure: null };
}
const jsonFile = (file, secret) => ({
  path: file.path,
  status: file.status,
  changes: maskChanges(file.changes, secret),
});
const jsonAssistant = (entry, secret) => ({
  id: entry.id,
  name: entry.name,
  detected: entry.detected,
  evidence: entry.evidence,
  manual: entry.manual,
  ...(entry.error ? { error: entry.error } : {}),
  ...(entry.steps.length ? { steps: entry.steps } : {}),
  files: entry.files.map(file => jsonFile(file, secret)),
});

const providerOptions = () => Object.values(PROVIDERS).map(provider => ({
  value: provider.id,
  label: provider.name,
  hint: `${provider.model}, key in ${provider.envVar}${token(provider) ? ' (set)' : ''}`,
}));

function pickerOptions(entries) {
  return entries.map(entry => {
    const pending = pendingOf(entry).length;
    return {
      value: entry.id,
      label: entry.detected ? entry.name : `${entry.name} (not detected)`,
      hint: entry.manual ? 'manual steps only'
        : entry.error ? 'needs attention'
          : pending ? 'not set up yet' : 'already configured',
    };
  });
}

async function commandInit(rest) {
  const flags = readFlags(rest, 'init');
  if (flags.help) { printHelp(); return; }
  const journalFile = journalPath();
  // Each write is journaled right after it lands, so an unreadable journal must stop init before
  // the first write rather than leave a file behind that undo cannot reach.
  if (flags.mode !== 'preview') await readJournal(journalFile);
  const batch = randomUUID();
  // Machine callers pick with --provider and --assistants and never get a prompt.
  const asking = !flags.json && flags.mode === 'prompt';
  let provider = flags.provider ?? defaultProvider();
  if (!flags.json) ui.intro('Apex CLI · Configure Apex for your favorite harness', MODE_NOTE[flags.mode]);
  if (asking && !flags.provider) {
    const picked = await ui.selectProvider(providerOptions(), provider.id);
    if (picked === false) return;
    provider = PROVIDERS[picked];
  }
  const secret = token(provider);
  // The machine payload carries values, not diffs, so do not pay for a diff nobody reads.
  const options = { secret, showDiff: flags.showDiff && !flags.json };
  const entries = await planAll(await detect(), options, provider);
  let ids = flags.selected ?? entries.filter(entry => entry.detected).map(entry => entry.id);
  if (asking && !flags.selected) {
    const defaults = entries.filter(entry => entry.detected && !entry.manual && !entry.error && pendingOf(entry).length)
      .map(entry => entry.id);
    const picked = await ui.selectAssistants(pickerOptions(entries), defaults, provider.model);
    if (picked === false) return;
    ids = picked;
  }
  const chosen = ids.map(id => entries.find(entry => entry.id === id));
  const blocked = chosen.filter(entry => entry.error);
  const manual = chosen.filter(entry => entry.manual && !entry.error);
  const active = chosen.filter(entry => !entry.manual && !entry.error);
  const files = active.flatMap(entry => entry.files);
  const pending = files.filter(file => file.status !== 'unchanged').map(file => file.change);

  // One apply step, used by the interactive report and by --json alike.
  const applyOne = async change => {
    const backup = await writeChange(change);
    await appendEntry(journalFile, newEntry(change, batch, backup));
    return backup;
  };

  if (flags.json) {
    const writes = flags.mode === 'apply' && !blocked.length ? pending : [];
    const { applied, failure } = await applyAll(writes, async change => { await applyOne(change); return change.path; });
    console.log(JSON.stringify({
      command: 'init',
      mode: flags.mode,
      provider: provider.id,
      model: provider.model,
      endpoint: provider.baseUrl,
      applied: applied.length,
      appliedPaths: applied,
      ...(failure ? { error: failure.message } : {}),
      blocked: blocked.map(entry => ({ id: entry.id, error: entry.error })),
      manualSetup: manual.map(entry => entry.id),
      assistants: chosen.map(entry => jsonAssistant(entry, secret)),
      journal: journalFile,
      undo: `${APEX} undo`,
      envVar: provider.envVar,
      nextSteps: active.filter(entry => RUNNABLE.includes(entry.id)).map(entry => `${APEX} run ${entry.id}`),
    }, null, 2));
    if (blocked.length || failure) process.exitCode = 1;
    return;
  }

  if (!ids.length) {
    ui.outro(`No assistant selected, so nothing was written. Pick one with --assistants or run ${APEX} init interactively.`);
    return;
  }
  if (flags.mode !== 'prompt') {
    ui.prose(`${ui.gray('gateway:')} ${provider.name}`);
    ui.prose(`${ui.gray('setup for:')} ${chosen.map(entry => entry.name + (entry.detected ? '' : ' (not detected)')).join(', ')}`);
  }
  if (blocked.length) {
    ui.plain('');
    for (const entry of blocked) ui.error(`${entry.name}: ${shortPath(entry.error)}`);
    ui.outro(`Blocked by the configuration problems above. Nothing was written. Fix those files and run ${APEX} init again.`);
    process.exitCode = 1;
    return;
  }
  let applied = 0;
  if (active.length) {
    const result = await runWrites({
      title: 'Planned changes',
      files,
      options,
      mode: flags.mode,
      prompt: 'Apply these changes?',
      hint: 'Existing files get a .apex-backup-<id> copy first.',
      pending,
      write: async change => {
        const backup = await applyOne(change);
        return `${ui.bold(shortPath(change.path))} ${ui.dim(backup ? `backup: ${basename(backup)}` : 'created')}`;
      },
    });
    // Declining is the end of the run, just like cancelling the picker.
    if (result.declined) return;
    applied = result.applied;
  }
  const apex = APEX !== 'apex' && flags.mode === 'prompt' && await installApex() ? 'apex' : APEX;
  // Steps for the assistants Apex CLI will not touch come after the diff, which is the part
  // people are reviewing.
  for (const entry of active.filter(entry => entry.steps.length)) ui.section(`Finish setting up ${entry.name}`, entry.steps);
  for (const entry of manual) {
    ui.section(`Manual setup for ${entry.name}: Apex CLI writes nothing`, manualSteps(entry.id, provider));
  }
  ui.section('Environment', [
    ...(secret ? [] : [`export ${provider.envVar}=<${provider.keyName.replace(/^your /, '')}>`]),
    secret ? `${ui.green('\u2713')} ${provider.envVar} is set in this shell`
      : `${ui.yellow('!')}  ${provider.envVar} is not set here yet`,
    ...(!secret && provider.keysUrl ? [`Create a key at ${ui.link(provider.keysUrl)}`] : []),
    ui.dim('Apex CLI never reads, stores or logs the key itself.'),
  ]);
  const runnable = active.map(entry => entry.id).filter(id => RUNNABLE.includes(id));
  const installed = { openCode: await openCodeMajor(active.find(entry => entry.id === 'opencode')?.binary) };
  const rows = runnable.map(id => ({ command: `${apex} run ${id}`, expansion: runExpansion(id, provider, installed) }));
  const commandWidth = ui.columnWidth(rows.map(row => row.command));
  ui.section(runnable.length
    ? `Use these commands to run ${provider.model} with your selected harnesses:`
    : `Use ${provider.model} with your assistant:`, [
    // A long expansion folds under itself instead of back to the gutter, so the command column stays clear.
    ...rows.flatMap(row => ui.wrap(row.expansion, ui.width() - 3 - commandWidth)
      .map((part, index) => `${ui.pad(index ? '' : row.command, commandWidth)}${ui.dim(part)}`)),
    '',
    `...or pick "${provider.model}" from the UI when setting up manually.`,
    `For more instructions, visit: ${ui.link(provider.guideUrl)}`,
    // Only a run that wrote something has anything to take back.
    ...(applied ? ['', `If you want to undo the changes, run ${ui.bold(`${apex} undo`)}`] : []),
    ...(apex === 'apex' ? [] : ['', ui.dim('For the short apex command: npm install -g @callstack/apex')]),
  ]);
}

async function commandDetect(rest) {
  const flags = readFlags(rest, 'detect');
  if (flags.help) { printHelp(); return; }
  const provider = flags.provider ?? defaultProvider();
  const secret = token(provider);
  const entries = await planAll(await detect(), { secret, showDiff: false }, provider);
  if (flags.json) {
    console.log(JSON.stringify(entries.map(entry => jsonAssistant(entry, secret)), null, 2));
    return;
  }
  ui.intro(`Apex CLI · What this machine has for ${provider.name}`, 'Read only: nothing is created, edited or removed.');
  const rows = entries.map(entry => {
    const pending = pendingOf(entry).length;
    return {
      entry,
      text: entry.manual ? 'manual setup'
        : entry.error ? 'unreadable config'
          : pending ? 'needs setup' : 'already configured',
      shade: entry.manual ? ui.dim : entry.error || pending ? ui.yellow : ui.gray,
    };
  });
  const nameWidth = ui.columnWidth(rows.map(row => row.entry.name));
  const stateWidth = ui.columnWidth(rows.map(row => row.text));
  // `found` and `absent` share one column, so the room left for the evidence is fixed; when the
  // terminal is too narrow for it, the evidence is dropped rather than squeezing the names.
  const lead = 8 + nameWidth + stateWidth;
  const room = ui.width() - 3 - lead;
  for (const { entry, text, shade } of rows) {
    const found = entry.evidence ? shortPath(entry.evidence) : 'no config found';
    const evidence = room >= 8 ? ui.clip(found, room) : '';
    ui.plain(`${ui.pad(entry.detected ? ui.green('found') : ui.dim('absent'), 8)}${ui.pad(entry.name, nameWidth)}${shade(evidence ? ui.pad(text, stateWidth) : text)}${ui.dim(evidence)}`);
  }
  ui.outro(`Next: ${APEX} init`);
}

async function commandUndo(rest) {
  const flags = readFlags(rest, 'undo');
  if (flags.help) { printHelp(); return; }
  // Undo may cross gateways, so it redacts with whichever key this shell holds.
  const secret = token(defaultProvider());
  const options = { secret, showDiff: flags.showDiff && !flags.json };
  const journalFile = journalPath();
  const entries = await readJournal(journalFile);
  if (flags.list) {
    if (flags.json) {
      console.log(JSON.stringify({ command: 'undo', journal: journalFile, entries }, null, 2));
      return;
    }
    const batches = batchIds(entries);
    ui.intro('Apex CLI · Setup history', 'Only the journal is read here; configs stay untouched.');
    for (const batch of batches) {
      const items = entries.filter(entry => entry.batch === batch);
      ui.prose(`${ui.gray(stamp(items[0].at))}  ${ui.bold(items.length === 1 ? '1 file' : `${items.length} files`)}  ${items.every(item => item.undoneAt) ? ui.gray('undone') : ui.yellow('pending')}`);
      for (const item of items) ui.prose(`${ui.dim(ui.clip(shortPath(item.path), ui.width() - 3))}${item.undoneAt ? ui.gray('  (already undone)') : ''}`);
    }
    if (!batches.length) ui.plain(ui.dim('nothing recorded yet'));
    ui.outro(`Journal: ${shortPath(journalFile)}`);
    return;
  }
  const plan = await planUndo(entries);
  const skipped = plan?.planned.filter(item => item.action === 'skip') ?? [];
  const restorable = [];
  const files = [];
  for (const item of plan?.planned.filter(entry => entry.action !== 'skip') ?? []) {
    try {
      files.push({ ...describeFile(item.change, options), status: item.action === 'remove' ? 'remove' : 'restore' });
      restorable.push(item);
    } catch (error) {
      // Display values are a view of the change, not a precondition for reversing it: one file
      // Apex CLI cannot read is reported and left alone instead of cancelling the whole undo.
      skipped.push({ entry: item.entry, reason: `its stored contents cannot be read: ${error.message}` });
    }
  }

  // One apply step, used by the interactive report and by --json alike. Returns the backup it kept.
  const applyOne = async item => {
    if (item.action === 'remove') await removeChange(item.change);
    const backup = item.action === 'restore' ? await writeChange(item.change) : null;
    await markUndone(journalFile, item.entry);
    return backup;
  };

  if (flags.json) {
    const writes = flags.mode === 'apply' ? restorable : [];
    const { applied, failure } = await applyAll(writes, async item => { await applyOne(item); return item.entry.path; });
    console.log(JSON.stringify({
      command: 'undo',
      mode: flags.mode,
      journal: journalFile,
      batch: plan?.batch ?? null,
      at: plan?.at ?? null,
      applied: applied.length,
      appliedPaths: applied,
      ...(failure ? { error: failure.message } : {}),
      files: files.map(file => jsonFile(file, secret)),
      skipped: skipped.map(item => ({ path: item.entry.path, reason: item.reason })),
    }, null, 2));
    if (failure) process.exitCode = 1;
    return;
  }

  ui.intro('Apex CLI · Undo the last setup', MODE_NOTE[flags.mode]);
  if (!plan) {
    ui.outro(entries.length
      ? `Everything Apex CLI has written here has already been undone. History: ${APEX} undo --list (journal: ${shortPath(journalFile)})`
      : `Nothing recorded yet, so nothing to undo. Journal: ${shortPath(journalFile)}`);
    return;
  }
  if (skipped.length) ui.plain('');
  for (const item of skipped) ui.warn(`${ui.bold(shortPath(item.entry.path))} stays as it is: ${shortPath(item.reason)}`);
  if (!restorable.length) {
    ui.outro('No file Apex CLI wrote can be restored safely. Nothing was written.');
    return;
  }
  const result = await runWrites({
    title: `Undo of the setup from ${stamp(plan.at)}`,
    files,
    options,
    mode: flags.mode,
    prompt: 'Undo these changes?',
    hint: 'Files Apex CLI created are deleted; edited files go back to their pre-setup contents.',
    pending: restorable,
    write: async item => {
      const backup = await applyOne(item);
      const path = ui.bold(shortPath(item.entry.path));
      return item.action === 'remove'
        ? `${path} ${ui.dim('deleted (Apex CLI created it)')}`
        : `${path} ${ui.dim(`restored; current contents kept as ${basename(backup)}`)}`;
    },
  });
  if (result.applied) ui.outro('Undone. Configs are back to how they were. Restart any open assistant to reload them.');
}

// `--provider` belongs to apex only right before or right after the assistant; anything later is
// the assistant's own argument and passes through untouched.
function takeProvider(args) {
  const [first, second] = args;
  if (first === '--provider') return { value: second ?? '', rest: args.slice(2) };
  if (first?.startsWith('--provider=')) return { value: first.slice('--provider='.length), rest: args.slice(1) };
  return { value: null, rest: args };
}

const isDirectory = path => stat(path).then(info => info.isDirectory(), () => false);

// OpenCode 2 flags belong to the command they follow. The interface (bare, flags first or a
// directory), `run` and `mini` take --standalone; other subcommands such as `auth list` reject it.
async function launchArgs(options, args) {
  const [first, ...rest] = args;
  if (options.afterCommand && ['run', 'mini'].includes(first)) return [first, ...options.args, ...rest];
  if (options.afterCommand && first && !first.startsWith('-') && !await isDirectory(first)) return args;
  return [...options.args, ...args];
}

async function commandRun(rest) {
  const before = takeProvider(rest);
  const [id, ...after] = before.rest;
  if (!RUNNABLE.includes(id)) throw new Error(`apex run needs one of: ${RUNNABLE.join(', ')}. See ${APEX} --help.`);
  const behind = before.value === null ? takeProvider(after) : { value: null, rest: after };
  const chosen = before.value ?? behind.value;
  if (chosen !== null && !PROVIDER_IDS.includes(chosen)) throw new Error(`Unknown --provider. Choose from: ${PROVIDER_IDS.join(', ')}`);
  const passed = behind.rest;
  const provider = chosen === null ? defaultProvider() : PROVIDERS[chosen];
  // A missing key is reported before a missing binary.
  launchToken(process.env, provider);
  const binary = await executable(id);
  if (!binary) throw new Error(`${id} was not found on PATH. Install it first, then run ${APEX} init.`);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    throw new Error('Windows .cmd/.bat launchers are not executed through a shell. Use WSL or launch the configured assistant directly.');
  }
  // OpenCode 1 and 2 take the model in different ways, so the launch depends on which is installed.
  const options = launchOptions(id, process.env, provider, { openCode: await openCodeMajor(id === 'opencode' && binary) });
  const args = passed[0] === '--' ? passed.slice(1) : passed;
  const child = spawn(binary, await launchArgs(options, args), { env: options.env, stdio: 'inherit', shell: false });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); resolve(); });
  });
}

// Completions are generated from the same COMMANDS/FLAGS tables the parser reads, so a shell can
// never offer a flag for a command that would reject it.
const GLOBALS = [['--version', 'print the version'], ['--help', 'show all commands']];

// One description of a flag, then each shell dialect only formats it.
const completionsFor = command => COMMANDS[command].flags.map(flag => ({
  long: `--${flag}`,
  short: FLAGS[flag].short ? `-${FLAGS[flag].short}` : null,
  hint: FLAGS[flag].hint,
  // `--assistants` and `--provider` are the flags whose values the shells can complete from a table.
  ...(command === 'init' && flag === 'assistants' ? { values: IDS } : {}),
  ...(flag === 'provider' ? { values: PROVIDER_IDS } : {}),
}));
const spellings = entry => [entry.long, entry.short].filter(Boolean);

function completionScript(shell) {
  const taking = Object.keys(COMMANDS).filter(name => COMMANDS[name].flags.length);
  const words = list => list.join(' ');
  if (shell === 'zsh') {
    return `#compdef apex
_apex() {
  local -a commands assistants providers runnable${taking.length ? ' ' : ''}${words(taking.map(name => `${name}_flags`))}
  commands=(${words([
      ...Object.entries(COMMANDS).map(([name, command]) => `'${name}:${command.summary}'`),
      ...GLOBALS.map(([flag, text]) => `'${flag}:${text}'`),
    ])})
  assistants=(${words(IDS)})
  providers=(${words(PROVIDER_IDS)})
  runnable=(${words(RUNNABLE)})
${taking.map(name => `  ${name}_flags=(${words(completionsFor(name).flatMap(entry =>
    spellings(entry).map(word => `'${word}:${entry.hint}'`)))})`).join('\n')}
  if (( CURRENT == 2 )); then
    _describe -t commands 'apex command' commands
  elif [[ "\${words[CURRENT - 1]}" == --assistants ]]; then
    _describe -t assistants 'assistant' assistants
  elif [[ "\${words[CURRENT - 1]}" == --provider ]]; then
    _describe -t providers 'gateway' providers
  else
    case "\${words[2]}" in
${taking.map(name => `      ${name}) _describe -t flags 'option' ${name}_flags ;;`).join('\n')}
      run) (( CURRENT == 3 )) && _describe -t assistants 'assistant' runnable ;;
      completion) _describe -t shells 'shell' '(${words(SHELLS)})' ;;
    esac
  fi
}
# Autoloaded from $fpath, this file body is the first completion call, so it must complete too.
if [[ "\${funcstack[1]}" == _apex ]]; then _apex "$@"; else compdef _apex apex; fi
`;
  }
  if (shell === 'bash') {
    return `_apex_completions() {
  local sub="\${COMP_WORDS[1]}" prev="\${COMP_WORDS[COMP_CWORD - 1]}" current="\${COMP_WORDS[COMP_CWORD]}"
  if [[ "$prev" == --assistants ]]; then COMPREPLY=( $(compgen -W "${words(IDS)}" -- "$current") ); return; fi
  if [[ "$prev" == --provider ]]; then COMPREPLY=( $(compgen -W "${words(PROVIDER_IDS)}" -- "$current") ); return; fi
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W "${words([...Object.keys(COMMANDS), ...GLOBALS.map(([flag]) => flag)])}" -- "$current") )
    return
  fi
  case "$sub" in
${taking.map(name => `    ${name}) COMPREPLY=( $(compgen -W "${words(completionsFor(name).flatMap(spellings))}" -- "$current") ) ;;`).join('\n')}
    run) (( COMP_CWORD == 2 )) && COMPREPLY=( $(compgen -W "${words(RUNNABLE)}" -- "$current") ) ;;
    completion) (( COMP_CWORD == 2 )) && COMPREPLY=( $(compgen -W "${words(SHELLS)}" -- "$current") ) ;;
  esac
}
complete -F _apex_completions apex
`;
  }
  const fish = (condition, { long, short, hint, values }) =>
    `complete -c apex -f -n "${condition}" -l ${long.slice(2)}`
    + `${short ? ` -s ${short.slice(1)}` : ''}${values ? ` -a "${words(values)}"` : ''} -d '${hint}'`;
  return [
    ...Object.entries(COMMANDS).map(([name, command]) => `complete -c apex -f -n "__fish_use_subcommand" -a ${name} -d '${command.summary}'`),
    ...GLOBALS.map(([flag, hint]) => `complete -c apex -f -n "__fish_use_subcommand" -l ${flag.slice(2)} -d '${hint}'`),
    ...taking.flatMap(name => completionsFor(name).map(entry => fish(`__fish_seen_subcommand_from ${name}`, entry))),
    ...RUNNABLE.map(id => `complete -c apex -f -n "__fish_seen_subcommand_from run" -a ${id} -d 'assistant'`),
    fish('__fish_seen_subcommand_from run', { long: '--provider', short: null, hint: FLAGS.provider.hint, values: PROVIDER_IDS }),
    ...SHELLS.map(name => `complete -c apex -f -n "__fish_seen_subcommand_from completion" -a ${name} -d 'shell'`),
  ].join('\n') + '\n';
}

function commandCompletion(rest) {
  const [shell] = rest;
  if (!SHELLS.includes(shell)) throw new Error(`apex completion needs one of: ${SHELLS.join(', ')}.`);
  process.stdout.write(completionScript(shell));
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ['--help', '-h', 'help'].includes(command)) { printHelp(); return; }
  if (['--version', '-v'].includes(command)) {
    console.log(await packageVersion());
    return;
  }
  if (command === 'completion') return commandCompletion(rest);
  if (command === 'run') return commandRun(rest);
  if (command === 'init') return commandInit(rest);
  if (command === 'detect') return commandDetect(rest);
  if (command === 'undo') return commandUndo(rest);
  throw new Error(`Unknown command: ${command}. See apex --help.`);
}

main(process.argv.slice(2)).catch(error => {
  const line = `Apex CLI: ${error.message}`;
  if (interactive()) console.error(styleText('red', line));
  else console.error(line);
  process.exitCode = 1;
});

// `apex init | head -1` closes the pipe early; quitting quietly beats a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', error => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}
