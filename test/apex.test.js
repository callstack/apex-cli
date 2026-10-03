import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { detect, locations, planAssistant, launchOptions, MODEL } from '../src/assistants.js';
import { addToml, updateToml, editJson, parseJson, readConfig, sha256, writeChange } from '../src/config.js';
import { diffValues, unifiedDiff } from '../src/diff.js';
import { isSecretKey, redactText } from '../src/secrets.js';
import { journalPath, markUndone } from '../src/journal.js';
import { wrap } from '../src/ui.js';

const BIN = resolve('bin/apex.js');

// Everything Apex prints lives in a 3-space gutter that matches clack's own text column, so the
// grid assertions ask for that column instead of hard-coding it a dozen times.
const COL = '   ';
const at = pattern => new RegExp(`^${COL}(?:${pattern.source.replace(/^\^/, '')})`, 'm');

async function fixture(context) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'apex-test-')));
  context.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: '',
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), XDG_CONFIG_HOME: join(home, '.config'),
    APPDATA: join(home, 'AppData', 'Roaming'), APEX_STATE_DIR: join(home, '.apex-state'),
    CALLSTACK_AUTH_TOKEN: 'secret-test-token', NO_COLOR: '1', FORCE_COLOR: '0' };
  // `npm test` and `npx` set this, and it decides how follow-up commands are spelled.
  delete env.CI;
  delete env.npm_command;
  return { home, env, journal: join(home, '.apex-state', 'journal.json') };
}

const cli = (args, env) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
const exists = path => access(path).then(() => true, () => false);

const OPENCODE = '{\n  // keep this\n  "theme": "dark",\n  "model": "anthropic/claude-opus-4.5"\n}\n';
const CLAUDE = '{\n  "env": { "CLAUDE_CODE_ATTRIBUTION_HEADER": "1" },\n  "theme": "dark"\n}\n';
const INIT = ['init', '--assistants', 'opencode,codex,claude,pi'];

// Config paths by assistant id, resolved with the CLI's own resolver instead of hand-built paths.
const FILE = { opencode: 'opencode.json', codex: 'callstack_ai.config.toml', claude: 'settings.json', pi: 'models.json' };
const configPath = (env, id) => join(locations(env.HOME, env, 'linux')[id], FILE[id]);
const writeConfig = async (env, id, contents) => {
  const path = configPath(env, id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
};

async function seedHome(env) {
  await writeConfig(env, 'opencode', OPENCODE);
  await writeConfig(env, 'claude', CLAUDE);
  // Codex is detected by its directory, and init creates its file there.
  await mkdir(env.CODEX_HOME, { recursive: true });
}

test('JSONC edits preserve comments, unrelated settings and existing provider models', () => {
  const before = '{\n  // keep this\n  "theme": "dark",\n  "provider": {"other": {"name": "Other"}},\n}\n';
  const after = editJson(before, [[['provider', 'callstack.ai', 'models', MODEL], { name: 'Apex' }]], 'test');
  assert.match(after, /\/\/ keep this/);
  assert.equal(parseJson(after).theme, 'dark');
  assert.deepEqual(parseJson(after).provider.other, { name: 'Other' });
  assert.equal(editJson(after, [[['provider', 'callstack.ai', 'models', MODEL], { name: 'Apex' }]], 'test'), after);
});

test('malformed and incompatible JSON is refused', () => {
  for (const before of ['{ broken', '[]', 'null', '{"provider": []}']) {
    assert.throws(() => editJson(before, [[['provider', 'callstack.ai'], {}]], 'fixture'));
  }
});

test('TOML preserves comments and root settings while adding tables', () => {
  const before = '# keep\nmodel = "callstack/Apex"\n[features]\nthing = true\n';
  const desired = { model: MODEL, model_provider: 'callstack_ai', model_providers: { callstack_ai: { name: 'callstack.ai' } } };
  const after = addToml(before, desired, 'test');
  assert.match(after, /# keep/);
  assert.deepEqual(parseToml(after), { ...desired, features: { thing: true } });
  assert.equal(addToml(after, desired, 'test'), after);
  assert.throws(() => addToml('model = "other"', desired, 'test'), /Conflicting/);
  assert.throws(() => addToml('invalid = [', desired, 'test'), /Invalid TOML/);
});

test('TOML appends only what is missing so diffs stay readable', () => {
  const before = 'model_provider = "callstack_ai"\nmodel = "callstack/Apex"\n';
  const desired = { model: MODEL, model_provider: 'callstack_ai', model_providers: { callstack_ai: { name: 'callstack.ai' } } };
  const after = addToml(before, desired, 'test');
  assert.deepEqual(diffValues({ before, after, format: 'toml' }),
    [{ op: 'add', key: 'model_providers.callstack_ai.name', value: 'callstack.ai' }]);
  assert.match(after, /^model_provider = "callstack_ai"\nmodel = "callstack\/Apex"\n\n\[model_providers]/);
  assert.ok(!after.includes('\n\n\n'), after);
  const diff = unifiedDiff('~/.codex/config.toml', before, after);
  assert.deepEqual(diff.slice(0, 3), ['--- ~/.codex/config.toml', '+++ ~/.codex/config.toml', '@@ -1,2 +1,6 @@']);
  assert.ok(!diff.slice(3).some(line => line.startsWith('-')), 'existing lines must not be rewritten');
});

test('value diffs describe added, replaced and removed settings for both formats', () => {
  const added = diffValues({ before: '{"a":1}', after: '{"a":1,"b":{"c":[2]}}' });
  assert.deepEqual(added, [{ op: 'add', key: 'b.c', value: [2] }]);
  assert.deepEqual(diffValues({ before: '{"a":"1"}', after: '{"a":"0"}' }),
    [{ op: 'replace', key: 'a', value: '0', oldValue: '1' }]);
  assert.deepEqual(diffValues({ before: 'x = "y"\n', after: '', format: 'toml' }), [{ op: 'remove', key: 'x', value: 'y' }]);
  assert.throws(() => diffValues({ before: 'not json', after: '{}' }), /Invalid JSON/);
  assert.deepEqual(diffValues({ before: null, after: '[t]\nk = true\n', format: 'toml' }),
    [{ op: 'add', key: 't.k', value: true }]);
});

test('TOML upgrades preserve comments, quoted keys, multiline values and unrelated providers', () => {
  const before = '# keep\r\n"model" = "old # inside" # model comment\r\nmodel_max_output_tokens = 65536\r\nmodel_reasoning_effort = """\r\nmax\r\n"""\r\n[model_providers."callstack_ai"] # provider comment\r\nbase_url = "https://old.example/v1" # URL comment\r\ncustom = "keep"\r\n[model_providers.other]\r\nname = "Other"\r\n';
  const desired = { model: MODEL, model_reasoning_effort: 'medium',
    model_providers: { callstack_ai: { base_url: 'https://api.callstack.ai/v1', wire_api: 'responses' } } };
  const after = updateToml(before, desired, 'test', ['model_max_output_tokens']);
  const value = parseToml(after);
  assert.equal(value.model, MODEL);
  assert.equal(value.model_reasoning_effort, 'medium');
  assert.equal(value.model_max_output_tokens, undefined);
  assert.equal(value.model_providers.callstack_ai.custom, 'keep');
  assert.equal(value.model_providers.callstack_ai.wire_api, 'responses');
  assert.deepEqual(value.model_providers.other, { name: 'Other' });
  for (const comment of ['# keep', '# model comment', '# provider comment', '# URL comment']) assert.ok(after.includes(comment));
  assert.ok(!after.replaceAll('\r\n', '').includes('\n'));
  assert.equal(updateToml(after, desired, 'test', ['model_max_output_tokens']), after);
  const inline = updateToml('model_providers = { callstack_ai = { base_url = "old", custom = 1 }, other = { name = "Other" } }\n', desired, 'test');
  assert.equal(parseToml(inline).model_providers.callstack_ai.custom, 1);
  assert.equal(parseToml(inline).model_providers.other.name, 'Other');
  assert.throws(() => updateToml('model = [', desired, 'test'), /Invalid TOML/);
});

test('secret-looking keys are detected in camelCase, snake_case and dotted paths', () => {
  for (const key of ['apiKey', 'api_key', 'env_key', 'auth', 'providers.x.apiKey', 'ANTHROPIC_AUTH_TOKEN', 'client-secret']) {
    assert.equal(isSecretKey(key), true, key);
  }
  for (const key of ['baseUrl', 'base_url', 'models', 'keyboard', 'wire_api', 'requires_openai_auth2', 'name']) {
    assert.equal(isSecretKey(key), false, key);
  }
});

test('secret values are redacted for display, env references stay visible', () => {
  const text = [
    '"apiKey": "sk-live-abcdef012345",',
    '"apiKey": "{env:CALLSTACK_AUTH_TOKEN}"',
    'env_key = "CALLSTACK_AUTH_TOKEN"',
    'other_key = "literal-secret-value"',
    'requires_openai_auth = false',
    'token = "secret-test-token"',
  ].join('\n');
  const redacted = redactText(text, 'secret-test-token');
  assert.ok(redacted.includes('"apiKey": <redacted>'), redacted);
  assert.ok(redacted.includes('"{env:CALLSTACK_AUTH_TOKEN}"'), redacted);
  assert.ok(redacted.includes('"CALLSTACK_AUTH_TOKEN"'), redacted);
  assert.ok(redacted.includes('other_key = <redacted>'), redacted);
  assert.ok(redacted.includes('requires_openai_auth = false'), redacted);
  assert.ok(!redacted.includes('secret-test-token') && !redacted.includes('literal-secret-value'), redacted);
});

test('detection uses executable files and config directories without executing binaries', async context => {
  const { home, env } = await fixture(context);
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pi'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  await writeFile(join(bin, 'claude'), 'not executable', { mode: 0o600 });
  await mkdir(env.CODEX_HOME);
  const result = await detect({ home, env: { ...env, PATH: bin }, platform: 'linux', cwd: home });
  assert.equal(result.find(item => item.id === 'pi').detected, true);
  assert.equal(result.find(item => item.id === 'claude').detected, false);
  assert.equal(result.find(item => item.id === 'codex').detected, true);
  assert.equal(result.find(item => item.id === 'cursor').detected, false);
  assert.equal(result.find(item => item.id === 'ai-sdk').detected, false, 'no package.json here');
});

test('an AI SDK project gets the connector snippet, and nothing is written into it', async context => {
  const { home, env } = await fixture(context);
  const project = join(home, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), JSON.stringify({ dependencies: { ai: '^5.0.0' } }));
  const [found] = (await detect({ home, env, platform: 'linux', cwd: project })).filter(item => item.id === 'ai-sdk');
  assert.equal(found.detected, true);
  assert.equal(found.evidence, join(project, 'package.json'));
  const result = spawnSync(process.execPath, [BIN, 'init', '--assistants', 'ai-sdk', '--apply'], { env, cwd: project, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, at(/^ {2}apiKey: process\.env\.CALLSTACK_AUTH_TOKEN,$/));
  assert.doesNotMatch(result.stdout, /modelContextWindowTokens|220000|262144/);
  assert.match(result.stdout, /maxOutputTokens: 32768/);
  assert.deepEqual(await readdir(project), ['package.json']);
});

test('platform locations respect Windows and environment overrides', () => {
  const paths = locations('/home/test', { APPDATA: '/roaming', CODEX_HOME: '/custom/codex', XDG_CONFIG_HOME: '/xdg' }, 'win32');
  assert.equal(paths.cursor, join('/roaming', 'Cursor'));
  assert.equal(paths.opencode, join('/xdg', 'opencode'));
  assert.equal(paths.codex, '/custom/codex');
  assert.equal(journalPath({ APEX_STATE_DIR: '/state' }), join('/state', 'journal.json'));
  assert.equal(journalPath({ XDG_STATE_HOME: '/xdg-state' }, '/home/x', 'linux'), join('/xdg-state', 'apex', 'journal.json'));
});

test('all automatic adapters configure and repeat without changing files', async context => {
  const { home, env } = await fixture(context);
  const paths = locations(home, env);
  for (const id of ['codex', 'claude', 'opencode', 'pi']) {
    const assistant = { id, directory: paths[id] };
    for (const change of await planAssistant(assistant)) {
      await writeChange(change);
      assert.equal((await stat(change.path)).mode & 0o777, 0o600);
      assert.ok(!(await readFile(change.path, 'utf8')).includes(env.CALLSTACK_AUTH_TOKEN));
    }
    const again = await planAssistant(assistant);
    assert.ok(again.every(change => change.before === change.after), id);
  }
  const codex = parseToml(await readFile(join(paths.codex, 'callstack_ai.config.toml'), 'utf8'));
  assert.equal(codex.model, MODEL);
  assert.equal(codex.model_providers.callstack_ai.wire_api, 'responses');
  assert.equal(codex.model_context_window, 262144);
  assert.equal(codex.model_reasoning_effort, 'medium');
  assert.equal(codex.model_auto_compact_token_limit, undefined);
  // Codex has no output-token setting; `codex --strict-config` rejects the field outright.
  assert.ok(!('model_max_output_tokens' in codex));
  const opencode = parseJson(await readFile(join(paths.opencode, 'opencode.json'), 'utf8'));
  const apex = opencode.provider['callstack.ai'].models[MODEL];
  assert.equal(apex.tool_call, true);
  assert.deepEqual(apex.limit, { context: 262144, output: 32768 });
  assert.deepEqual(Object.keys(apex.variants), ['none', 'low', 'medium', 'xhigh']);
  const pi = parseJson(await readFile(join(paths.pi, 'models.json'), 'utf8'));
  assert.equal(pi.providers.callstack.apiKey, '$CALLSTACK_AUTH_TOKEN');
  assert.equal(pi.providers.callstack.models[0].maxTokens, 32768);
  assert.equal(pi.providers.callstack.models[0].contextWindow, 262144);
});

test('CLI previews, applies and undoes an outdated Codex profile without changing base config', async context => {
  const { env } = await fixture(context);
  const base = '# default stays\nmodel = "other"\n[model_providers.callstack_ai]\nwire_api = "chat"\n';
  await mkdir(env.CODEX_HOME, { recursive: true });
  await writeFile(join(env.CODEX_HOME, 'config.toml'), base);
  const old = '# old Apex profile\nmodel = "callstack/Apex"\nmodel_provider = "callstack_ai"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 220000\nmodel_max_output_tokens = 65536\nmodel_reasoning_effort = "max"\n[features]\ncustom = true\n';
  const path = await writeConfig(env, 'codex', old);
  const preview = cli(['init', '--assistants', 'codex', '--no-interactive', '--json'], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(await readFile(path, 'utf8'), old);
  const applied = cli(['init', '--assistants', 'codex', '--apply'], env);
  assert.equal(applied.status, 0, applied.stderr);
  const value = parseToml(await readFile(path, 'utf8'));
  assert.equal(value.model_context_window, 262144);
  assert.equal(value.model_auto_compact_token_limit, undefined);
  assert.equal(value.model_reasoning_effort, 'medium');
  assert.equal(value.model_max_output_tokens, undefined);
  assert.equal(value.model_providers.callstack_ai.wire_api, 'responses');
  assert.equal(value.features.custom, true);
  assert.equal(await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8'), base);
  const upgraded = await readFile(path, 'utf8');
  assert.equal(cli(['init', '--assistants', 'codex', '--apply'], env).status, 0);
  assert.equal(await readFile(path, 'utf8'), upgraded);
  assert.equal(cli(['undo', '--apply'], env).status, 0);
  assert.equal(await readFile(path, 'utf8'), old);
});

test('outdated OpenCode and Pi budgets and efforts upgrade while preserving custom settings', async context => {
  const { home, env } = await fixture(context);
  for (const v2 of [false, true]) {
    const directory = locations(home, env).opencode;
    const root = v2 ? 'providers' : 'provider';
    const settings = v2 ? 'settings' : 'options';
    const old = { theme: 'dark', [root]: { 'callstack.ai': { custom: true, [settings]: { apiKey: 'stored', custom: 1 }, models: {
      other: { name: 'Other' }, [MODEL]: { custom: 2, limit: { context: 262144, input: 220000, output: 65536 },
        [settings]: { reasoningEffort: 'minimal', custom: 3 }, variants: v2 ? [{ id: 'max' }] : { max: { reasoningEffort: 'max' } } },
    } } } };
    await writeConfig(env, 'opencode', JSON.stringify(old));
    const [change] = await planAssistant({ id: 'opencode', directory });
    const provider = parseJson(change.after)[root]['callstack.ai'];
    assert.equal(provider.custom, true);
    assert.equal(provider[settings].custom, 1);
    assert.equal(provider[settings].apiKey, 'stored');
    assert.equal(provider.models.other.name, 'Other');
    assert.equal(provider.models[MODEL].custom, 2);
    assert.equal(provider.models[MODEL][settings].custom, 3);
    assert.equal(provider.models[MODEL][settings].reasoningEffort, 'medium');
    assert.equal(provider.models[MODEL].limit.output, 32768);
    assert.deepEqual(provider.models[MODEL].limit, { context: 262144, output: 32768 });
    assert.deepEqual(v2 ? provider.models[MODEL].variants.map(v => v.id) : Object.keys(provider.models[MODEL].variants), ['none', 'low', 'medium', 'xhigh']);
    await writeChange(change);
    const [repeat] = await planAssistant({ id: 'opencode', directory });
    assert.equal(repeat.before, repeat.after);
  }
  const directory = locations(home, env).pi;
  await writeConfig(env, 'pi', JSON.stringify({ providers: { callstack: { apiKey: 'stored', models: [
    { id: MODEL, contextWindow: 262144, maxTokens: 131072, custom: true, compat: { supportsStore: false, reasoningEffortMap: { minimal: 'minimal' } } },
  ] } } }));
  const [change] = await planAssistant({ id: 'pi', directory });
  const provider = parseJson(change.after).providers.callstack;
  assert.equal(provider.apiKey, 'stored');
  assert.equal(provider.models[0].maxTokens, 32768);
  assert.equal(provider.models[0].custom, true);
  assert.equal(provider.models[0].contextWindow, 262144);
  assert.deepEqual(provider.models[0].compat, { supportsStore: false });
  assert.equal(provider.models[0].thinkingLevelMap.minimal, null);
  assert.equal(provider.models[0].thinkingLevelMap.max, null);
  assert.equal(provider.models[0].thinkingLevelMap.off, 'none');
});

test('CLI upgrades context metadata to official model limits with preview, repeat and undo', async context => {
  const { env } = await fixture(context);
  const originals = {
    opencode: JSON.stringify({ provider: { 'callstack.ai': { models: {
      [MODEL]: { limit: { output: 32768 } },
      other: { limit: { context: 1000000 } },
    } } } }),
    pi: JSON.stringify({ providers: { callstack: { models: [
      { id: MODEL, maxTokens: 32768 },
      { id: 'other', contextWindow: 1000000 },
    ] } } }),
  };
  for (const [id, text] of Object.entries(originals)) await writeConfig(env, id, text);
  const args = ['init', '--assistants', 'opencode,pi'];
  assert.equal(cli([...args, '--no-interactive'], env).status, 0);
  for (const [id, text] of Object.entries(originals)) assert.equal(await readFile(configPath(env, id), 'utf8'), text);
  assert.equal(cli([...args, '--apply'], env).status, 0);
  const upgraded = {};
  for (const id of Object.keys(originals)) upgraded[id] = await readFile(configPath(env, id), 'utf8');
  const opencode = parseJson(upgraded.opencode).provider['callstack.ai'].models;
  assert.deepEqual(opencode[MODEL].limit, { context: 262144, output: 32768 });
  assert.equal(opencode.other.limit.context, 1000000);
  const pi = parseJson(upgraded.pi).providers.callstack.models;
  assert.equal(pi[0].contextWindow, 262144);
  assert.equal(pi[0].maxTokens, 32768);
  assert.equal(pi[1].contextWindow, 1000000);
  assert.equal(cli([...args, '--apply'], env).status, 0);
  for (const [id, text] of Object.entries(upgraded)) assert.equal(await readFile(configPath(env, id), 'utf8'), text);
  assert.equal(cli(['undo', '--apply'], env).status, 0);
  for (const [id, text] of Object.entries(originals)) assert.equal(await readFile(configPath(env, id), 'utf8'), text);
});

test('Pi keeps other providers and models', async context => {
  const { home, env } = await fixture(context);
  const directory = locations(home, env).pi;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: {
    other: { models: [{ id: 'other' }] }, callstack: { models: [{ id: 'legacy' }, { id: MODEL }, { id: 'later' }] },
  } }));
  const [change] = await planAssistant({ id: 'pi', directory });
  const value = parseJson(change.after);
  assert.equal(value.providers.other.models[0].id, 'other');
  // An Apex entry from an earlier setup is upgraded in place, next to models it does not own.
  const models = value.providers.callstack.models;
  assert.deepEqual(models.map(model => model.id), ['legacy', MODEL, 'later']);
  assert.equal(models[1].contextWindow, 262144);
  assert.equal(models[1].reasoning, true);
});

test('Pi saves the Apex thinking default for direct launches and upgrades it reversibly', async context => {
  const { env } = await fixture(context);
  const path = join(env.PI_CODING_AGENT_DIR, 'settings.json');
  const original = '{\n // keep this\n "defaultProvider": "other", "defaultModel": "other-model",\n "defaultThinkingLevel": "low",\n "modelThinkingLevels": {"callstack/callstack/Apex": "off", "other/other-model": "medium"}\n}\n';
  await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(path, original);
  const preview = cli(['init', '--assistants', 'pi', '--no-interactive'], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(await readFile(path, 'utf8'), original);
  const applied = cli(['init', '--assistants', 'pi', '--apply'], env);
  assert.equal(applied.status, 0, applied.stderr);
  const updated = await readFile(path, 'utf8');
  const settings = parseJson(updated);
  assert.equal(settings.modelThinkingLevels['callstack/callstack/Apex'], 'medium');
  assert.equal(settings.modelThinkingLevels['other/other-model'], 'medium');
  assert.equal(settings.defaultThinkingLevel, 'low');
  assert.equal(settings.defaultProvider, 'other');
  assert.equal(settings.defaultModel, 'other-model');
  assert.match(updated, /keep this/);
  assert.equal(cli(['init', '--assistants', 'pi', '--apply'], env).status, 0);
  assert.equal(await readFile(path, 'utf8'), updated);
  assert.equal(cli(['undo', '--apply'], env).status, 0);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('upgrading from 0.2 keeps the keys it stored, so nobody is left sending no key', async context => {
  const { home, env } = await fixture(context);
  const paths = locations(home, env);
  // What 0.2 wrote: OpenCode's key in its own key store, and Pi's key inline.
  const authFile = join(home, '.local', 'share', 'opencode', 'auth.json');
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(authFile, JSON.stringify({ 'callstack.ai': { type: 'api', key: 'sk-stored-by-0.2' } }));
  await mkdir(paths.opencode, { recursive: true });
  await writeFile(join(paths.opencode, 'opencode.json'), JSON.stringify({ provider: { 'callstack.ai': { options: { baseURL: 'https://api.callstack.ai/v1' } } } }));
  const [opencode] = await planAssistant({ id: 'opencode', directory: paths.opencode, authFile });
  assert.equal(parseJson(opencode.after).provider['callstack.ai'].options.apiKey, undefined);
  // Without a stored key, the config references the environment as before.
  const [fresh] = await planAssistant({ id: 'opencode', directory: paths.opencode, authFile: join(home, 'none.json') });
  assert.equal(parseJson(fresh.after).provider['callstack.ai'].options.apiKey, '{env:CALLSTACK_AUTH_TOKEN}');

  await mkdir(paths.pi, { recursive: true });
  const pi = key => writeFile(join(paths.pi, 'models.json'), JSON.stringify({ providers: { callstack: { apiKey: key, models: [{ id: MODEL }] } } }));
  const piKey = async () => parseJson((await planAssistant({ id: 'pi', directory: paths.pi }))[0].after).providers.callstack.apiKey;
  await pi('sk-stored-by-0.2');
  assert.equal(await piKey(), 'sk-stored-by-0.2');
  await pi('XXX');
  assert.equal(await piKey(), '$CALLSTACK_AUTH_TOKEN', "0.2's placeholder is not a key");
});

test('OpenCode JSONC is edited in place, v2 config gets the v2 shape, ambiguous config is refused', async context => {
  const { home, env } = await fixture(context);
  const directory = locations(home, env).opencode;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'opencode.jsonc'), '{ // preserved\n "theme": "dark"\n}');
  const [change] = await planAssistant({ id: 'opencode', directory });
  assert.match(change.path, /\.jsonc$/);
  assert.match(change.after, /preserved/);
  await writeFile(join(directory, 'opencode.jsonc'), '{"providers": {"other": {}}}');
  const [v2] = await planAssistant({ id: 'opencode', directory });
  const providers = parseJson(v2.after).providers;
  assert.deepEqual(Object.keys(providers), ['other', 'callstack.ai']);
  assert.equal(providers['callstack.ai'].models[MODEL].capabilities.tools, true);
  assert.ok(!('provider' in parseJson(v2.after)), 'no v1 block next to a v2 config');
  assert.match(v2.steps[0], /\/connect/);
  await writeFile(join(directory, 'opencode.json'), '{}');
  await assert.rejects(planAssistant({ id: 'opencode', directory }), /Both/);
});

test('private backups preserve original bytes and concurrent changes are refused', async context => {
  const { home } = await fixture(context);
  const path = join(home, 'settings.json');
  const before = '{"private":"original"}\n';
  await writeFile(path, before);
  const backup = await writeChange({ path, before, after: '{"new":true}\n' });
  assert.equal(await readFile(backup, 'utf8'), before);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  await assert.rejects(writeChange({ path, before, after: '{}' }), /changed/);
  assert.equal((await readdir(home)).filter(name => name.includes('apex-tmp')).length, 0);
});

test('symlink files and parent directories are refused', async context => {
  const { home } = await fixture(context);
  const target = join(home, 'real');
  await mkdir(target);
  await writeFile(join(target, 'config'), '{}');
  await symlink(target, join(home, 'linked'));
  await symlink(join(target, 'config'), join(home, 'file-link'));
  await assert.rejects(readConfig(join(home, 'linked', 'config')), /symbolic link/);
  await assert.rejects(readConfig(join(home, 'file-link')), /symbolic link/);
});

test('launch config scopes Claude credentials without mutating parent environment', () => {
  const env = { CALLSTACK_AUTH_TOKEN: 'secret', ANTHROPIC_API_KEY: 'old', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '131072', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '99' };
  const launched = launchOptions('claude', env);
  assert.equal(launched.env.ANTHROPIC_AUTH_TOKEN, 'secret');
  assert.equal(launched.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launched.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, 'old');
  assert.equal(launched.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32768');
  assert.equal(launched.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.equal(launched.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  assert.equal(launched.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  const fresh = launchOptions('claude', { CALLSTACK_AUTH_TOKEN: 'secret' }).env;
  assert.equal(fresh.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
  for (const key of ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']) {
    assert.equal(fresh[key], undefined);
  }
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '131072');
  assert.deepEqual(launchOptions('codex', env).args, ['--profile', 'callstack_ai']);
  assert.deepEqual(launchOptions('opencode', env).args, ['--model', 'callstack.ai/callstack/Apex']);
  assert.throws(() => launchOptions('pi', {}), /CALLSTACK_AUTH_TOKEN/);
});

test('CLI defaults to a preview: nothing is written without --apply', async context => {
  const { home, env, journal } = await fixture(context);
  await seedHome(env);
  for (const extra of [['--no-interactive'], []]) {
    const result = cli([...INIT, ...extra], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, at(/^Planned changes:$/));
    assert.match(result.stdout, /baseURL/);
    assert.ok(!result.stdout.includes(env.CALLSTACK_AUTH_TOKEN));
    assert.equal(await exists(journal), false, extra.join(' '));
    const written = await readdir(join(env.XDG_CONFIG_HOME, 'opencode'));
    assert.deepEqual(written.filter(name => name.includes('apex-')), [], extra.join(' '));
  }
  const compact = cli([...INIT, '--no-interactive', '--no-diff'], env);
  assert.match(compact.stdout, /provider\.callstack\.ai\.options\.baseURL/);
  const untouched = await Promise.all([
    readFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8'),
    readFile(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
  ]);
  assert.deepEqual(untouched, [OPENCODE, CLAUDE]);
});

test('CLI shows the file diff by default, shortens paths and redacts secrets', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  await writeConfig(env, 'claude', '{\n  "apiKey": "sk-super-secret-9999",\n  "env": { "CLAUDE_CODE_ATTRIBUTION_HEADER": "1" }\n}\n');
  const result = cli([...INIT, '--no-interactive'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@@/);
  assert.ok(!result.stdout.includes('sk-super-secret-9999'), result.stdout);
  assert.match(result.stdout, /<redacted>/);
  // Diff headers match the ~/ paths used by the file list above them.
  assert.match(result.stdout, at(/^--- ~/));
  assert.ok(!result.stdout.includes(env.CLAUDE_CONFIG_DIR), 'diff headers must not leak absolute home paths');

  const compact = cli([...INIT, '--no-interactive', '--no-diff'], env);
  assert.equal(compact.status, 0, compact.stderr);
  assert.ok(!compact.stdout.includes('@@'), compact.stdout);
  assert.match(compact.stdout, /~ env\.CLAUDE_CODE_ATTRIBUTION_HEADER  1 \u2192 0/);
});

test('the header banner draws a box with aligned edges', async context => {
  const { env } = await fixture(context);
  const out = cli(['detect'], { ...env, COLUMNS: '70' }).stdout.split('\n');
  const box = out.filter(line => /^\s+[\u2502\u250c\u2514]/.test(line));
  assert.equal(box.length, 5, out.join('\n'));
  const widths = new Set(box.map(line => line.replace(/\u001b\[[0-9;]*m/g, '').length));
  assert.equal(widths.size, 1, `ragged banner: ${[...widths].join(',')}`);
  assert.match(box[0], /\u2510$/);
  assert.match(box.at(-1), /\u2518$/);
});

test('human output keeps one indentation grid', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  const result = cli([...INIT, '--no-interactive'], env);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  const row = pattern => lines.some(line => at(pattern).test(line));
  assert.ok(row(/^Planned changes:$/), 'heading');
  assert.ok(row(/^Update +~/), 'file row');
  assert.ok(row(/^\+\S/), 'diff row');
  const compact = cli([...INIT, '--no-interactive', '--no-diff'], env).stdout.split('\n');
  assert.ok(compact.some(line => at(/^[+~-] \S/).test(line)), 'key/value row without --no-diff');
  assert.ok(row(/^--- ~/), 'diff header');
  assert.ok(row(/^Environment$/), 'section heading');
  assert.ok(row(/^\u2713 CALLSTACK_AUTH_TOKEN is set in this shell$/), 'section body');
  const unset = cli([...INIT, '--no-interactive', '--no-diff'], { ...env, CALLSTACK_AUTH_TOKEN: '' }).stdout;
  assert.match(unset, at(/^export CALLSTACK_AUTH_TOKEN=<your callstack\.ai key>$/));
  assert.ok(!at(/^\u2713/).test(unset), unset);
  assert.ok(!lines.some(line => /^\S/.test(line)), `nothing may start at column 0: ${lines.find(l => /^\S/.test(l))}`);

  // The longest status label must still be spaced away from the path.
  cli([...INIT, '--apply'], env);
  assert.match(cli([...INIT, '--no-interactive'], env).stdout, at(/^Unchanged {2}~/));
});

test('the model id is highlighted green wherever it is shown', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  const color = { ...env, FORCE_COLOR: '1' };
  delete color.NO_COLOR;
  const result = cli([...INIT, '--no-interactive', '--no-diff'], color);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\u001b\[32mcallstack\/Apex\u001b\[39m/);
  assert.match(result.stdout, /Configure \u001b\[32mcallstack\/Apex\u001b\[39m for your favorite harness/);
  // Highlighting must not break the padded columns.
  assert.match(result.stdout.replace(/\u001b\[[0-9;]*m/g, ''), at(/^[+~-] \S+ {2}\S/));
});

test('colour is applied only when stdout is a terminal', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  const piped = { ...env };
  delete piped.NO_COLOR;
  delete piped.FORCE_COLOR;
  // spawnSync gives the child a pipe, so colour must switch itself off without NO_COLOR help.
  assert.ok(!/\u001b\[/.test(cli([...INIT, '--no-interactive', '--no-diff'], piped).stdout));
  const color = { ...env, FORCE_COLOR: '1' };
  delete color.NO_COLOR;
  assert.match(cli([...INIT, '--no-interactive', '--no-diff'], color).stdout, /\u001b\[32m/);
});

test('CLI refuses to write when a selected assistant has an unusable config', async context => {
  const { home, env } = await fixture(context);
  await seedHome(env);
  await writeConfig(env, 'pi', 'invalid');
  const failed = cli([...INIT, '--apply'], env);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Pi:/);
  assert.equal(await readFile(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'), CLAUDE);
  assert.equal(await exists(join(home, '.apex-state')), false);
});

test('CLI applies once, repeats cleanly and writes a private journal', async context => {
  const { home, env, journal } = await fixture(context);
  await seedHome(env);
  const applied = cli([...INIT, '--apply'], env);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /backup: [a-z.]+apex-backup-[0-9a-f]{8}/);
  assert.equal((await stat(journal)).mode & 0o777, 0o600);
  const entries = JSON.parse(await readFile(journal, 'utf8'));
  assert.equal(entries.length, 5);
  assert.equal(entries.filter(entry => entry.created).length, 3);
  const repeated = cli([...INIT, '--apply'], env);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, at(/^Planned changes: nothing to change$/));
  assert.match(repeated.stdout, at(/^Already configured\. Nothing to write\.$/));
  assert.equal(JSON.parse(await readFile(journal, 'utf8')).length, 5);
  assert.ok((await readdir(join(env.XDG_CONFIG_HOME, 'opencode'))).some(name => name.includes('.apex-backup-')));
});

test('undo restores edited files byte for byte and deletes created files', async context => {
  const { env, home, journal } = await fixture(context);
  await seedHome(env);
  assert.equal(cli([...INIT, '--apply'], env).status, 0);
  const before = {
    journal: await readFile(journal, 'utf8'),
    codex: await readFile(join(env.CODEX_HOME, 'callstack_ai.config.toml'), 'utf8'),
  };
  const preview = cli(['undo', '--no-interactive'], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Undo of the setup from/);
  assert.match(preview.stdout, /Restore .*settings\.json/);
  assert.match(preview.stdout, /Delete .*callstack_ai\.config\.toml/);
  assert.equal(await readFile(join(env.CODEX_HOME, 'callstack_ai.config.toml'), 'utf8'), before.codex);
  const undone = cli(['undo', '--apply'], env);
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(await readFile(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'), CLAUDE);
  assert.equal(await readFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8'), OPENCODE);
  assert.equal(await exists(join(env.CODEX_HOME, 'callstack_ai.config.toml')), false);
  assert.equal(await exists(join(env.PI_CODING_AGENT_DIR, 'models.json')), false);
  assert.match(undone.stdout, /restored/);
  const listed = cli(['undo', '--list'], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /already undone/);
  const again = cli(['undo', '--apply'], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already been undone/);
  const marked = JSON.parse(await readFile(journal, 'utf8'));
  assert.equal(marked.length, JSON.parse(before.journal).length, 'the batch stays in the journal');
  assert.ok(marked.every(entry => typeof entry.undoneAt === 'string'), 'every entry is marked undone');
});

test('a setup whose files can only be skipped does not block older ones', async context => {
  const { env } = await fixture(context);
  assert.equal(cli(['init', '--assistants', 'codex', '--apply'], env).status, 0);
  assert.equal(cli(['init', '--assistants', 'pi', '--apply'], env).status, 0);
  const pi = configPath(env, 'pi');
  await writeFile(pi, '{}\n');
  await writeFile(join(env.PI_CODING_AGENT_DIR, 'settings.json'), '{}\n');
  const undone = cli(['undo', '--apply'], env);
  assert.equal(undone.status, 0, undone.stderr);
  assert.equal(await exists(configPath(env, 'codex')), false, 'the older setup is undone');
  assert.equal(await readFile(pi, 'utf8'), '{}\n', 'the edited file stays as it is');
});

test('undo --list --json prints the journal as JSON', async context => {
  const { env, journal } = await fixture(context);
  assert.equal(cli(['init', '--assistants', 'codex', '--apply'], env).status, 0);
  const listed = JSON.parse(cli(['undo', '--list', '--json'], env).stdout);
  assert.equal(listed.journal, journal);
  assert.deepEqual(listed.entries.map(entry => entry.path), [configPath(env, 'codex')]);
});

test('an unreadable journal stops init before anything is written', async context => {
  const { env, journal } = await fixture(context);
  await mkdir(dirname(journal), { recursive: true });
  await writeFile(journal, '{bad');
  for (const args of [['init', '--assistants', 'codex', '--apply'], ['init', '--assistants', 'codex', '--apply', '--json']]) {
    const result = cli(args, env);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /journal is not valid JSON/);
  }
  assert.equal(await exists(configPath(env, 'codex')), false);
  // A preview writes nothing, so it does not need the journal.
  assert.equal(cli(['init', '--assistants', 'codex', '--no-interactive'], env).status, 0);
});

test('undo leaves files that changed elsewhere untouched and explains why', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  assert.equal(cli([...INIT, '--apply'], env).status, 0);
  const edited = '{"theme": "light", "model": "someone-elses-choice"}\n';
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), edited);
  const undone = cli(['undo', '--apply'], env);
  assert.equal(undone.status, 0, undone.stderr);
  assert.match(undone.stdout, /stays as it is: changed by something else/);
  assert.equal(await readFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8'), edited);
  assert.equal(await exists(join(env.CODEX_HOME, 'callstack_ai.config.toml')), false, 'other files still undo');
});

test('json output is machine readable, mode-correct and free of secrets', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  await writeFile(join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
    '{\n  "apiKey": "sk-super-secret-9999",\n  "env": { "CLAUDE_CODE_ATTRIBUTION_HEADER": "1" }\n}\n');
  const plan = cli([...INIT, '--json'], env);
  assert.equal(plan.status, 0, plan.stderr);
  const parsed = JSON.parse(plan.stdout);
  assert.equal(parsed.mode, 'preview');
  assert.equal(parsed.applied, 0);
  assert.equal(parsed.envVar, 'CALLSTACK_AUTH_TOKEN');
  assert.equal(parsed.undo, 'apex undo');
  assert.equal(parsed.assistants.length, 4);
  assert.ok(!plan.stdout.includes('sk-super-secret-9999'));
  assert.ok(!plan.stdout.includes(env.CALLSTACK_AUTH_TOKEN));
  const added = parsed.assistants.find(a => a.id === 'opencode').files[0].changes;
  assert.equal(added.find(change => change.key === 'provider.callstack.ai.options.apiKey').value,
    '{env:CALLSTACK_AUTH_TOKEN}', 'credential references stay visible, they are not secrets');
  const detectJson = JSON.parse(cli(['detect', '--json'], env).stdout);
  assert.equal(detectJson.length, 7);
  assert.equal(detectJson.find(entry => entry.id === 'pi').detected, false);
  assert.ok(detectJson.every(entry => 'files' in entry));
});

test('CLI validates flags and commands', async context => {
  const { env } = await fixture(context);
  assert.equal(cli(['--version'], env).stdout.trim(), JSON.parse(await readFile('package.json', 'utf8')).version);
  assert.equal(cli(['--help'], env).status, 0);
  assert.match(cli(['--help'], env).stdout, /apex undo \[--list\] \[options\]/);
  for (const args of [['wat'], ['init', '--assistants', 'unknown'], ['init', '--assistants', ''], ['init', '--wat'],
    ['init', '--dry-run'], ['init', '--yes'], ['undo', '--yes'], ['run', 'unknown'], ['detect', '--apply']]) {
    assert.equal(cli(args, env).status, 1, args.join(' '));
  }
});

test('manual adapters never write editor credentials', async context => {
  const { home, env } = await fixture(context);
  for (const id of ['cursor', 'copilot']) assert.deepEqual(await planAssistant({ id, directory: home }), []);
  const result = cli(['init', '--assistants', 'cursor,copilot', '--apply'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cursor: Settings/);
  assert.match(result.stdout, /Manual setup for VS Code \(Copilot\)/);
  // Flat output below the header banner: only the banner may draw borders.
  const banner = result.stdout.split('\n');
  const body = banner.slice(banner.findIndex(line => line.includes('┘')) + 1);
  for (const border of ['╭', '╮', '╰', '╯', '│']) assert.ok(!body.some(line => line.includes(border)), `unexpected ${border}`);
  assert.deepEqual(await readdir(home), []);
});

test('manual steps come after the diff, and their snippets never lose their shape', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  const result = cli(['init', '--assistants', 'opencode,copilot,cursor', '--no-interactive'], env);
  assert.equal(result.status, 0, result.stderr);
  const plan = result.stdout.indexOf('Planned changes:');
  const manual = result.stdout.indexOf('Manual setup for');
  assert.ok(plan >= 0 && manual > plan, result.stdout);
  assert.match(result.stdout, /"contextWindow": 262144/);
  assert.match(result.stdout, /"maxOutputTokens": 32768/);
  assert.doesNotMatch(result.stdout, /"maxInputTokens"/);
  // The model object is one key per line, so it survives a narrow terminal as valid JSON.
  for (const key of ['"id"', '"url"', '"toolCalling"', '"vision"']) {
    assert.match(result.stdout, new RegExp(`^ +${key}: `, 'm'), result.stdout);
  }
});

test('CLI run forwards argument boundaries, child environment and exit status', async context => {
  const { home, env } = await fixture(context);
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), model: process.env.ANTHROPIC_MODEL, token: process.env.ANTHROPIC_AUTH_TOKEN }));\nprocess.exit(7);\n`, { mode: 0o755 });
  const result = cli(['run', 'claude', '--', 'a space', '$(touch should-not-exist)'], { ...env, PATH: bin });
  assert.equal(result.status, 7, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, ['--model', MODEL, 'a space', '$(touch should-not-exist)']);
  assert.equal(output.model, MODEL);
  assert.equal(output.token, env.CALLSTACK_AUTH_TOKEN);
});

test('closing the pipe early exits quietly instead of crashing', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  const result = spawnSync('/bin/sh', ['-c',
    `${process.execPath} ${BIN} init --no-interactive | /usr/bin/head -2`], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Apex/);
  assert.ok(!result.stderr.includes('EPIPE'), result.stderr);
});

test('completion scripts are generated for zsh, bash and fish', () => {
  for (const shell of ['zsh', 'bash', 'fish']) {
    const script = cli(['completion', shell], process.env).stdout;
    for (const command of ['init', 'detect', 'undo', 'run', 'completion']) assert.ok(script.includes(command), `${shell}: ${command}`);
    for (const flag of ['--no-interactive', '--apply', '--assistants', '--json']) assert.ok(script.includes(flag.replace('--', shell === 'fish' ? '-l ' : '--')), `${shell}: ${flag}`);
    for (const id of ['codex', 'opencode', 'pi']) assert.ok(script.includes(id), `${shell}: ${id}`);
  }
  const rejected = cli(['completion', 'tcsh'], process.env);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /zsh, bash, fish/);
});

test('the package registers apex as a global bin', async () => {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(pkg.bin.apex, 'bin/apex.js');
  assert.ok(pkg.files.includes('dist'), 'npm i -g must get a bundle without running scripts');
  assert.match(await readFile(BIN, 'utf8'), /^#!\/usr\/bin\/env node/);
  assert.ok(((await stat(BIN)).mode & 0o111) !== 0, 'bin must be executable for PATH linking');
});

test('the shipped binary is a single self-contained bundle', async () => {
  const bundled = await readFile(resolve('dist/cli.js'), 'utf8');
  const external = [...new Set([...bundled.matchAll(/(?:from|require)\s*\(\s*["']([^"'.][^"']*)["']/g)].map(match => match[1]))]
    .filter(name => !name.startsWith('node:'));
  assert.deepEqual(external, [], `bundle must inline its dependencies, found ${external.join(', ')}`);
  assert.match(bundled, /callstack\/Apex/);
});

test('diffs are symmetric: a created file comes from /dev/null and a deleted one goes to it', () => {
  const body = 'model = "m"\n[providers]\nx = 1\n';
  assert.deepEqual(unifiedDiff('~/.codex/c.toml', null, body).slice(0, 3),
    ['--- /dev/null', '+++ ~/.codex/c.toml', '@@ -0,0 +1,3 @@']);
  const deleted = unifiedDiff('~/.codex/c.toml', body, null);
  assert.deepEqual(deleted.slice(0, 3), ['--- ~/.codex/c.toml', '+++ /dev/null', '@@ -1,3 +0,0 @@']);
  // Nothing survives a deletion, so no line may be reported as unchanged context.
  assert.ok(!deleted.slice(3).some(line => line.startsWith(' ')), deleted.join('\n'));
});

test('a folded line keeps its leading indent', () => {
  assert.deepEqual(wrap('     "model": "callstack/Apex"', 20), ['     "model":', '"callstack/Apex"']);
});

test('redaction reaches nested values and leaves short tokens and headers alone', () => {
  assert.match(redactText('{"config": {"api_key": "sk-leak-123456"}}'), /"api_key": <redacted>/);
  assert.match(redactText('providers = { callstack = { client_secret = "leak-me-please" } }'),
    /client_secret = <redacted>/);
  // A list spread over several lines names its key only once, above the members.
  const listed = unifiedDiff('x.json', null, '{\n  "apiKeys": [\n    "sk-live-abcdef",\n    "sk-2"\n  ]\n}\n');
  assert.deepEqual(listed.slice(3), ['+{', '+  "apiKeys": [', '+    <redacted>,', '+    <redacted>', '+  ]', '+}']);
  // A one-character token is indistinguishable from ordinary text, so it must not be swept.
  const url = 'base_url = "https://api.callstack.ai/v1"';
  assert.equal(redactText(url, 'a'), url);
  // Path headers carry no credential, and masking them would mangle the file being shown.
  assert.deepEqual(unifiedDiff('~/.codex/token.toml', 'a = 1\n', 'a = 2\n', 'token').slice(0, 2),
    ['--- ~/.codex/token.toml', '+++ ~/.codex/token.toml']);
});

test('--json honours --apply and still reports a batch that failed halfway', async context => {
  const { home, env } = await fixture(context);
  await seedHome(env);
  const piDir = dirname(configPath(env, 'pi'));
  await mkdir(piDir, { recursive: true });
  await chmod(piDir, 0o500);
  const result = cli([...INIT, '--apply', '--json'], env);
  await chmod(piDir, 0o700);
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(parsed.mode, 'apply');
  assert.match(parsed.error, /EACCES/);
  assert.ok(parsed.applied >= 1 && parsed.applied < 4, `expected a partial batch, got ${parsed.applied}`);
  assert.equal(parsed.appliedPaths.length, parsed.applied);
  // What already landed must stay undoable, which is why the journal is written per file.
  assert.equal(cli(['undo', '--apply'], env).status, 0);
  assert.equal(await readFile(configPath(env, 'claude'), 'utf8'), CLAUDE);
});

test('each command accepts only its own flags, and help says who accepts what', async context => {
  const { env } = await fixture(context);
  for (const args of [['detect', '--no-diff'], ['detect', '--no-interactive'], ['undo', '--assistants', 'codex'], ['run', '--json']]) {
    assert.equal(cli(args, env).status, 1, args.join(' '));
  }
  assert.match(cli(['--help'], env).stdout, /^ {2}--list\s+\(undo\)\s+show recorded setups/m);
  assert.match(cli(['--help'], env).stdout, /^ {2}--assistants <ids>\s+\(init\)/m);
});

test('help is coloured, ordered and fits a narrow terminal', async context => {
  const { env } = await fixture(context);
  const help = cli(['--help'], { ...env, NO_COLOR: '0', FORCE_COLOR: '1', COLUMNS: '100' }).stdout;
  // Every command line: `apex` green, the command plain, whatever follows dim.
  assert.match(help, /\u001b\[32mapex\u001b\[39m init\u001b\[2m \[--assistants <ids>\] \[options\]\u001b\[22m/);
  assert.match(help, /\u001b\[32mapex\u001b\[39m init\u001b\[2m --assistants codex,pi --apply\u001b\[22m/);
  assert.match(help, /\u001b\[32mapex\u001b\[39m completion\u001b\[2m bash >> ~\/\.bashrc\u001b\[22m/);
  assert.match(help, /\u001b\[32mapex\u001b\[39m help +show all commands/, 'a bare command leaves no empty dim span');
  const wrapped = cli(['--help'], { ...env, NO_COLOR: '0', FORCE_COLOR: '1', COLUMNS: '44' }).stdout;
  assert.match(wrapped, /^ {2}\u001b\[2m<args>\]\u001b\[22m$/m, 'a wrapped command continues dim');
  assert.match(help, /\u001b\[1m\u001b\[4mUsage/, 'sections are bold and underlined');
  assert.match(help, /callstack\/Apex.*\u001b\[32m|\u001b\[32mcallstack\/Apex/, 'the model is green');
  // The promises belong in the README, and the safe default needs no flag to explain it.
  for (const gone of ['Safety:', 'Exit codes', '--dry-run', '--yes']) {
    assert.ok(!help.includes(gone), `help still mentions ${gone}`);
  }
  // Completion steps are the last thing a reader needs, so they sit at the bottom.
  const order = ['Usage', 'Options', 'Examples', 'Environment', 'Install completions']
    .map(name => help.indexOf(`\u001b[1m\u001b[4m${name}`));
  assert.ok(order.every(index => index >= 0), help);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), help);
  // Descriptions wrap instead of running off the edge, however narrow the terminal is.
  for (const columns of ['120', '80', '60', '44']) {
    const narrow = cli(['--help'], { ...env, COLUMNS: columns }).stdout.split('\n');
    const wide = narrow.filter(line => line.length > Number(columns));
    assert.deepEqual(wide, [], `COLUMNS=${columns}: ${wide.join('\n')}`);
  }
});

test('undo renders diffs by default, --no-diff included', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  assert.equal(cli([...INIT, '--apply'], env).status, 0);
  assert.match(cli(['undo', '--no-interactive'], env).stdout, /@@/);
  assert.ok(!cli(['undo', '--no-interactive', '--no-diff'], env).stdout.includes('@@'));
});

test('a journal entry with no backup is skipped with a reason instead of crashing undo', async context => {
  const { env, journal } = await fixture(context);
  const path = await writeConfig(env, 'claude', CLAUDE);
  await mkdir(dirname(journal), { recursive: true });
  await writeFile(journal, JSON.stringify([{
    batch: 'b1', at: new Date().toISOString(), path, format: 'json', created: false,
    beforeSha: sha256('{}\n'), afterSha: sha256(CLAUDE), backup: null, undoneAt: null,
  }], null, 2));
  const result = cli(['undo', '--no-interactive'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stays as it is: original backup was never recorded/);
  assert.equal(await readFile(path, 'utf8'), CLAUDE);
});

test('markUndone refuses to rewrite the journal for an entry it cannot find', async context => {
  const { journal } = await fixture(context);
  const entries = [{ batch: 'b', at: 'x', path: '/x', format: 'json', created: false,
    beforeSha: 'a', afterSha: 'b', backup: '/backup', undoneAt: null }];
  await mkdir(dirname(journal), { recursive: true });
  await writeFile(journal, JSON.stringify(entries));
  await assert.rejects(markUndone(journal, { batch: 'other', path: '/x' }), /no pending entry/);
  assert.equal(JSON.parse(await readFile(journal, 'utf8'))[0].undoneAt, null);
});

test('completions offer each flag only for the commands that accept it', () => {
  const script = shell => cli(['completion', shell], process.env).stdout;
  const lineWith = (text, needle) => text.split('\n').find(line => line.includes(needle));

  const bash = script('bash');
  const bashBranch = name => bash.split('\n').find(line => line.trim().startsWith(`${name})`));
  assert.match(bashBranch('detect'), /--json/);
  assert.ok(!bashBranch('detect').includes('--assistants'), bashBranch('detect'));
  assert.match(bashBranch('undo'), /--list/);
  assert.ok(!bashBranch('init').includes('--list'), bashBranch('init'));

  const zsh = script('zsh');
  // Per-command arrays are declared as locals, so completing leaks nothing into the user's shell.
  assert.match(zsh, /^ {2}local -a commands assistants runnable init_flags detect_flags undo_flags$/m);
  const zshFlags = name => lineWith(zsh, `${name}_flags=`);
  assert.match(zshFlags('detect'), /--json/);
  assert.ok(!zshFlags('detect').includes('--assistants'), zshFlags('detect'));
  assert.ok(!zshFlags('init').includes('--list'), zshFlags('init'));
  assert.match(zsh, /^ +undo\) _describe -t flags 'option' undo_flags ;;$/m);
  assert.match(zsh, /'-h:show help'/);

  const fish = script('fish');
  const fishFlags = name => fish.split('\n').filter(line => line.includes(`__fish_seen_subcommand_from ${name}"`));
  assert.ok(fishFlags('undo').some(each => each.includes('-l list')), fishFlags('undo').join('\n'));
  assert.ok(!fishFlags('detect').some(each => each.includes('assistants')), fishFlags('detect').join('\n'));
  assert.match(fish, /-l assistants -a "opencode codex claude pi cursor copilot ai-sdk"/);
  assert.ok(!fishFlags('run').some(each => each.includes('cursor')), 'run offers only what it can launch');
  assert.match(fish, /-l apply -d 'write without prompting'/);
  for (const each of fish.split('\n')) assert.equal((each.match(/'/g) || []).length % 2, 0, each);
  assert.ok(lineWith(fish, '-l version'), 'global flags are completed too');
});

test('bash completes commands, per-command flags and run targets', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 }, () => {
  const script = cli(['completion', 'bash'], process.env).stdout;
  const complete = line => {
    const probe = `${script}\nread -ra COMP_WORDS <<< "${line}"; COMP_WORDS+=("")
COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); _apex_completions; echo "\${COMPREPLY[*]}"`;
    return spawnSync('bash', ['-c', probe], { encoding: 'utf8' }).stdout.trim();
  };
  assert.match(complete('apex'), /^init detect undo /);
  assert.match(complete('apex undo'), /--list/);
  assert.match(complete('apex init --apply'), /--assistants/, 'flags complete after other flags too');
  assert.equal(complete('apex run'), 'codex claude opencode pi');
  assert.equal(complete('apex init --assistants'), 'opencode codex claude pi cursor copilot ai-sdk');
});

test('zsh completes on the very first call after autoloading', () => {
  const zsh = cli(['completion', 'zsh'], process.env).stdout;
  assert.match(zsh, /^if \[\[ "\$\{funcstack\[1\]\}" == _apex \]\]; then _apex "\$@"; else compdef _apex apex; fi$/m);
});

test('a batch that fails halfway is reported the same way by init and undo', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  assert.equal(cli([...INIT, '--apply'], env).status, 0);
  // A read-only Claude directory makes its restore fail on the backup, after the files before it
  // have already been reverted.
  await chmod(env.CLAUDE_CONFIG_DIR, 0o500);
  const result = cli(['undo', '--apply', '--json'], env);
  await chmod(env.CLAUDE_CONFIG_DIR, 0o700);
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(parsed.command, 'undo');
  assert.equal(parsed.mode, 'apply');
  assert.match(parsed.error, /EACCES/);
  assert.equal(parsed.appliedPaths.length, parsed.applied);
  assert.ok(parsed.applied >= 1, 'files before the failure are reported as applied');
  assert.ok(parsed.applied < parsed.files.length, 'the batch did not finish');
  // Both commands describe a partial batch with the same keys.
  assert.deepEqual(Object.keys(parsed).filter(key => key.startsWith('appl')), ['applied', 'appliedPaths']);
});

test('one unreadable restore is reported and skipped, the rest of the undo proceeds', async context => {
  const { env, journal } = await fixture(context);
  await seedHome(env);
  assert.equal(cli([...INIT, '--apply'], env).status, 0);
  const entries = JSON.parse(await readFile(journal, 'utf8'));
  const claude = entries.find(entry => entry.path === configPath(env, 'claude'));
  // Corrupt the backup and hash it as if it were the original: the plan accepts it, and only the
  // value view can fail. One unreadable file must not cancel the reversal.
  await writeFile(claude.backup, '{ broken');
  claude.beforeSha = sha256('{ broken');
  await writeFile(journal, JSON.stringify(entries, null, 2));
  const result = cli(['undo', '--no-interactive'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stays as it is: its stored contents cannot be read/);
  assert.match(result.stdout, /^ {3}Delete +~/m, 'the created Codex file is still planned for deletion');
  assert.equal(await readFile(configPath(env, 'claude'), 'utf8').then(text => JSON.parse(text).theme), 'dark');
});

test('narrow terminals fold every line inside the gutter instead of spilling to column 0', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  for (const args of [[...INIT, '--no-interactive'], ['undo', '--no-interactive'], ['detect'],
    ['init', '--assistants', 'opencode,copilot,cursor', '--no-interactive']]) {
    const result = cli(args, { ...env, COLUMNS: '44' });
    assert.equal(result.status, 0, result.stderr);
    for (const line of result.stdout.split('\n')) {
      const text = line.replace(/\u001b\[[0-9;]*m/g, '');
      // A URL is the one thing that must never be folded: a broken link cannot be opened.
      if (/^\s*https?:\/\//.test(text)) continue;
      assert.ok(text.length <= 44, `${args.join(' ')} too wide (${text.length}): ${text}`);
      // The header box is the one element drawn outside the gutter, one column left.
      if (text.trim() !== '' && !/^[\u2502\u250c\u2514]/.test(text.trim())) {
        assert.ok(text.startsWith(COL), `${args.join(' ')} outside the gutter: ${text}`);
      }
    }
  }
});

test('the closing block shows what each run command expands to, and when undo is honest', async context => {
  const { env } = await fixture(context);
  await seedHome(env);
  const applied = cli([...INIT, '--apply'], env);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, at(/^Use these commands to run callstack\/Apex with your selected harnesses:$/));
  assert.match(applied.stdout, at(/^apex run opencode {2}opencode --model callstack\.ai\/callstack\/Apex$/));
  assert.match(applied.stdout, at(/^apex run codex +codex --profile callstack_ai$/));
  assert.match(applied.stdout, at(/^apex run pi +pi --provider callstack --model callstack\/Apex --thinking medium$/));
  assert.match(applied.stdout, at(/^\.\.\.or pick "callstack\/Apex" from the UI when setting up manually\.$/));
  assert.match(applied.stdout, at(/^https:\/\/app\.notion\.com\/p\/callstack\/Apex-how-to-use-it-/));
  assert.match(applied.stdout, at(/^If you want to undo the changes, run apex undo$/));

  // A preview wrote nothing, so promising an undo would be wrong. Neither did a repeat run.
  const preview = cli([...INIT, '--no-interactive'], env);
  assert.ok(!/If you want to undo/.test(preview.stdout), preview.stdout);
  const repeated = cli([...INIT, '--apply'], env);
  assert.ok(!/If you want to undo/.test(repeated.stdout), repeated.stdout);
  // Started through npx there is no `apex` on PATH afterwards, so the next steps say npx too.
  const fresh = (await fixture(context)).env;
  const viaNpx = cli(['init', '--assistants', 'codex', '--apply'], { ...fresh, npm_command: 'exec' });
  assert.match(viaNpx.stdout, at(/^npx @callstack\/apex run codex +codex --profile callstack_ai$/));
  assert.match(viaNpx.stdout, at(/^If you want to undo the changes, run npx @callstack\/apex undo$/));
  assert.match(viaNpx.stdout, at(/^For the short apex command: npm install -g @callstack\/apex$/));
  assert.ok(!/For the short apex command/.test(applied.stdout), 'an installed apex needs no hint');
  // Manual-only setups get the guide without a run list they cannot use.
  const manual = cli(['init', '--assistants', 'cursor', '--apply'], env);
  assert.match(manual.stdout, at(/^Use callstack\/Apex with your assistant:$/));
  assert.ok(!/apex run cursor/.test(manual.stdout), manual.stdout);
});
