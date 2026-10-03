import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { editJson, parseJson, readConfig, updateToml } from './config.js';

export const MODEL = 'callstack/Apex';
export const BASE_URL = 'https://api.callstack.ai/v1';
export const GUIDE_URL = 'https://app.notion.com/p/callstack/Apex-how-to-use-it-36d5d027c0f880e99d03d1c37a77382f';
export const IDS = ['opencode', 'codex', 'claude', 'pi', 'cursor', 'copilot', 'ai-sdk'];
export const NAMES = {
  opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', pi: 'Pi',
  cursor: 'Cursor', copilot: 'VS Code (Copilot)', 'ai-sdk': 'Vercel AI SDK / Eve',
};
export const RUNNABLE = ['codex', 'claude', 'opencode', 'pi'];

// Apex model limits, declared using each harness's documented fields.
// App field names follow their official docs; compaction keeps each harness's defaults.
const CONTEXT_WINDOW = 262144;
const MAX_OUTPUT = 32768;
const EFFORTS = ['none', 'low', 'medium', 'xhigh'];
const OPENCODE_MODEL = {
  name: 'Apex',
  reasoning: true,
  tool_call: true,
  attachment: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: CONTEXT_WINDOW, output: MAX_OUTPUT },
  options: { reasoningEffort: 'medium' },
  variants: Object.fromEntries(EFFORTS.map(effort => [effort, { reasoningEffort: effort }])),
};
// OpenCode 2 renamed `provider` to `providers` and moved the capability fields around.
const OPENCODE_V2_PROVIDER = {
  name: 'callstack.ai',
  package: '@opencode/ai/providers/openai-compatible',
  settings: { baseURL: BASE_URL },
  models: {
    [MODEL]: {
      name: 'Apex',
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      limit: { context: CONTEXT_WINDOW, output: MAX_OUTPUT },
      settings: { reasoningEffort: 'medium' },
      variants: EFFORTS.map(effort => ({ id: effort, settings: { reasoningEffort: effort } })),
    },
  },
};
const PI_MODEL = {
  id: MODEL,
  reasoning: true,
  input: ['text', 'image'],
  thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null },
  contextWindow: CONTEXT_WINDOW,
  maxTokens: MAX_OUTPUT,
};

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

export async function executable(command, env = process.env, platform = process.platform) {
  const extensions = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env.PATH || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(directory, command + extension.toLowerCase());
      try {
        await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await stat(path)).isFile()) return path;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
      }
    }
  }
  return null;
}

export function locations(home = homedir(), env = process.env, platform = process.platform) {
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const userData = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming') : config;
  return {
    opencode: join(config, 'opencode'),
    codex: env.CODEX_HOME || join(home, '.codex'),
    claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    pi: env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'),
    cursor: join(userData, 'Cursor'),
    copilot: join(userData, 'Code'),
  };
}

// The AI SDK is a project dependency rather than a tool on this machine, so it is found in the
// package.json of the directory Apex CLI runs from.
async function aiSdkProject(cwd) {
  const path = join(cwd, 'package.json');
  let pkg;
  try { pkg = JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return ['ai', '@ai-sdk/openai', 'eve'].some(name => Object.hasOwn(deps, name)) ? path : null;
}

export async function detect(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const paths = locations(home, env, platform);
  return Promise.all(IDS.map(async id => {
    if (id === 'ai-sdk') {
      const evidence = await aiSdkProject(cwd);
      return { id, detected: Boolean(evidence), binary: null, evidence, directory: cwd };
    }
    const command = id === 'copilot' ? 'code' : id;
    const binary = await executable(command, env, platform);
    const markers = [paths[id]];
    if (platform === 'darwin' && ['cursor', 'copilot'].includes(id)) {
      const name = id === 'cursor' ? 'Cursor.app' : 'Visual Studio Code.app';
      markers.push(join('/Applications', name), join(home, 'Applications', name));
    }
    if (id === 'copilot') markers.push(join(home, '.vscode', 'extensions'));
    const found = [];
    for (const path of markers) if (await exists(path)) found.push(path);
    return {
      id, detected: Boolean(binary || found.length), binary, evidence: binary || found[0], directory: paths[id],
      ...(id === 'opencode' ? { authFile: join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json') } : {}),
    };
  }));
}

// A key the tool already holds keeps working after an upgrade: Apex CLI 0.2 put one in OpenCode's
// own key store and one in Pi's models.json. Only a tool without a key gets the environment
// reference, so an upgrade never leaves someone without CALLSTACK_AUTH_TOKEN sending no key.
async function openCodeHasKey(authFile) {
  if (!authFile) return false;
  try { return Object.hasOwn(JSON.parse(await readConfig(authFile) ?? '{}'), 'callstack.ai'); }
  catch { return false; }
}
// 0.2 wrote this placeholder when no key was given, so it counts as no key.
const PI_PLACEHOLDER = 'XXX';

export async function planAssistant(assistant) {
  const changes = [];
  const json = async (filename, updates) => {
    const path = join(assistant.directory, filename);
    const before = await readConfig(path);
    const after = editJson(before, typeof updates === 'function' ? updates(parseJson(before, path)) : updates, path);
    changes.push({ path, before, after, format: 'json' });
  };
  switch (assistant.id) {
    case 'opencode': {
      const hasJson = await exists(join(assistant.directory, 'opencode.json'));
      const hasJsonc = await exists(join(assistant.directory, 'opencode.jsonc'));
      if (hasJson && hasJsonc) throw new Error('Both opencode.json and opencode.jsonc exist. Consolidate them before init.');
      let v2 = false;
      const storedKey = await openCodeHasKey(assistant.authFile);
      await json(hasJsonc ? 'opencode.jsonc' : 'opencode.json', existing => {
        // The config says which format it is in; the binary is never run to ask. Anything not
        // already in the v2 shape gets v1, which OpenCode 2 still reads.
        v2 = Object.hasOwn(existing, 'providers');
        if (v2) return [
          [['providers', 'callstack.ai', 'name'], OPENCODE_V2_PROVIDER.name],
          [['providers', 'callstack.ai', 'package'], OPENCODE_V2_PROVIDER.package],
          [['providers', 'callstack.ai', 'settings', 'baseURL'], BASE_URL],
          ...Object.entries(OPENCODE_V2_PROVIDER.models[MODEL]).map(([key, value]) =>
            [['providers', 'callstack.ai', 'models', MODEL, key], key === 'settings'
              ? { ...existing.providers?.['callstack.ai']?.models?.[MODEL]?.settings, ...value } : value]),
        ];
        return [
        [['provider', 'callstack.ai', 'npm'], '@ai-sdk/openai-compatible'],
        [['provider', 'callstack.ai', 'name'], 'callstack.ai'],
        [['provider', 'callstack.ai', 'options', 'baseURL'], BASE_URL],
        ...(storedKey || existing.provider?.['callstack.ai']?.options?.apiKey
          ? [] : [[['provider', 'callstack.ai', 'options', 'apiKey'], '{env:CALLSTACK_AUTH_TOKEN}']]),
        ...Object.entries(OPENCODE_MODEL).map(([key, value]) =>
          [['provider', 'callstack.ai', 'models', MODEL, key], key === 'options'
            ? { ...existing.provider?.['callstack.ai']?.models?.[MODEL]?.options, ...value } : value]),
        ];
      });
      // OpenCode 2 keeps provider keys in its own store, so the key is the one step left to you.
      if (v2) changes[0].steps = ['OpenCode 2 stores provider keys itself: run /connect in OpenCode, pick callstack.ai → "Manually enter API Key", and paste your Callstack key.'];
      break;
    }
    case 'pi':
      await json('models.json', existing => {
        const models = existing.providers?.callstack?.models ?? [];
        const key = existing.providers?.callstack?.apiKey;
        if (!Array.isArray(models) || models.some(model => !model || typeof model.id !== 'string')) {
          throw new Error('Expected Pi models to be an array of model objects.');
        }
        return [
          [['providers', 'callstack', 'baseUrl'], BASE_URL],
          [['providers', 'callstack', 'api'], 'openai-completions'],
          ...(key && key !== PI_PLACEHOLDER ? [] : [[['providers', 'callstack', 'apiKey'], '$CALLSTACK_AUTH_TOKEN']]),
          // An Apex entry from an earlier setup is upgraded in place; other models keep their order.
          [['providers', 'callstack', 'models'], models.some(model => model.id === MODEL)
            ? models.map(model => (model.id === MODEL ? {
              ...model, ...PI_MODEL,
              ...(model.compat ? { compat: Object.fromEntries(Object.entries(model.compat)
                .filter(([key]) => key !== 'reasoningEffortMap')) } : {}),
            } : model)) : [...models, PI_MODEL]],
        ];
      });
      await json('settings.json', [[['modelThinkingLevels', `callstack/${MODEL}`], 'medium']]);
      break;
    case 'claude':
      await json('settings.json', [[['env', 'CLAUDE_CODE_ATTRIBUTION_HEADER'], '0']]);
      break;
    case 'codex': {
      const path = join(assistant.directory, 'callstack_ai.config.toml');
      const before = await readConfig(path);
      const after = updateToml(before, {
        model_provider: 'callstack_ai',
        model: MODEL,
        model_context_window: CONTEXT_WINDOW,
        model_reasoning_effort: 'medium',
        model_providers: { callstack_ai: {
          name: 'callstack.ai', base_url: BASE_URL, env_key: 'CALLSTACK_AUTH_TOKEN',
          wire_api: 'responses', requires_openai_auth: false,
        } },
      }, path, ['model_max_output_tokens', 'model_auto_compact_token_limit']);
      changes.push({ path, before, after, format: 'toml' });
      break;
    }
  }
  return changes;
}

export function launchOptions(id, env = process.env) {
  const token = env.CALLSTACK_AUTH_TOKEN;
  if (!token?.trim()) throw new Error('Set CALLSTACK_AUTH_TOKEN in your environment before launching.');
  const childEnv = { ...env };
  switch (id) {
    case 'opencode': return { args: ['--model', `callstack.ai/${MODEL}`], env: childEnv };
    case 'codex': return { args: ['--profile', 'callstack_ai'], env: childEnv };
    case 'pi': return { args: ['--provider', 'callstack', '--model', MODEL, '--thinking', 'medium'], env: childEnv };
    case 'claude':
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete childEnv[key];
      Object.assign(childEnv, {
        ANTHROPIC_BASE_URL: 'https://api.callstack.ai', ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_MODEL: MODEL, CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CONTEXT_WINDOW),
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT),
      });
      return { args: ['--model', MODEL], env: childEnv };
    default: throw new Error(`Cannot launch ${id}. Use the editor's model selector.`);
  }
}

// What `apex run <id>` actually types for you, so the summary can show the command it replaces.
// The placeholder token is never shown: only the argument list is part of the expansion.
const RUN_NOTE = { claude: '(ANTHROPIC_* gateway environment set)' };

export function runExpansion(id) {
  const { args } = launchOptions(id, { CALLSTACK_AUTH_TOKEN: 'placeholder' });
  return [`${id} ${args.join(' ')}`, RUN_NOTE[id]].filter(Boolean).join('  ');
}

// One line per key: the whole object on one line cannot be folded to a terminal, and a step that
// wraps into the gutter loses its shape.
const COPILOT_MODEL = JSON.stringify({
  id: MODEL, name: 'Apex', url: BASE_URL, toolCalling: true, vision: true, thinking: true,
  contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT,
  supportsReasoningEffort: EFFORTS, reasoningEffortFormat: 'chat-completions',
}, null, 2);

// Kept to short lines, so the snippet is never folded out of shape.
const AI_SDK_SNIPPET = [
  "import { createOpenAI } from '@ai-sdk/openai';",
  '',
  'const apex = createOpenAI({',
  "  name: 'callstack',",
  `  baseURL: '${BASE_URL}',`,
  '  apiKey: process.env.CALLSTACK_AUTH_TOKEN,',
  '});',
  'const requestOptions = {',
  `  model: apex('${MODEL}'),`,
  `  maxOutputTokens: ${MAX_OUTPUT},`,
  '};',
  '// Pass requestOptions with your prompt to generateText / streamText.',
  `// Reasoning effort (${EFFORTS.join(', ')}):`,
  "// providerOptions: { callstack: { reasoningEffort: 'medium' } }",
];

export const MANUAL = {
  cursor: [
    `Cursor: Settings → Models → API Keys → OpenAI API Key. Enter your Callstack key, override the base URL with ${BASE_URL}, add and enable ${MODEL}, then select it in Agent.`,
    'Cursor has no way to declare what a custom model can do (tool calling, vision, reasoning); it infers that itself.',
  ],
  copilot: [
    'Installation of Copilot itself is not verified: Copilot → model selector → Manage Models → Add Models → Custom Endpoint → name callstack.ai → enter your key → Chat Completions.',
    'Keep the generated apiKey secret reference; add this object to its models array:',
    ...COPILOT_MODEL.split('\n'),
  ],
  'ai-sdk': [
    'Apex CLI never writes your key into a project. Keep it in CALLSTACK_AUTH_TOKEN (for example in a .env that git ignores) and create the provider with:',
    ...AI_SDK_SNIPPET,
  ],
};
export const MANUAL_IDS = Object.keys(MANUAL);
