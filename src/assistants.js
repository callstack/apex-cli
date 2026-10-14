import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { editJson, parseJson, readConfig, updateToml } from './config.js';

// Apex is served by two gateways. Each one has its own model id, key and endpoints, and its own
// provider names in the configs, so switching gateways adds a provider instead of rewriting one.
const VERCEL = 'https://ai-gateway.vercel.sh';
export const PROVIDERS = {
  vercel: {
    id: 'vercel', name: 'Vercel AI Gateway', label: 'Vercel AI Gateway',
    model: 'callstack/apex', envVar: 'AI_GATEWAY_API_KEY', keyName: 'your Vercel AI Gateway API key',
    keysUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway&title=AI+Gateway',
    guideUrl: 'https://vercel.com/docs/ai-gateway/coding-agents',
    // The coding-agent surface is plain /v1 that tags the traffic; three agents have their own.
    // An app built on the AI SDK is not a coding agent, so it uses the general endpoint.
    baseUrl: `${VERCEL}/coding-agent/v1`, codexUrl: `${VERCEL}/codex/v1`,
    cursorUrl: `${VERCEL}/cursor/v1`, anthropicUrl: `${VERCEL}/claude-code`, appUrl: `${VERCEL}/v1`,
    opencode: 'apex-vercel', pi: 'apex-vercel', codex: 'apex_vercel',
  },
  callstack: {
    id: 'callstack', name: 'Callstack portal', label: 'callstack.ai',
    model: 'callstack/Apex', envVar: 'CALLSTACK_AUTH_TOKEN', keyName: 'your callstack.ai key',
    keysUrl: null,
    guideUrl: 'https://app.notion.com/p/callstack/Apex-how-to-use-it-36d5d027c0f880e99d03d1c37a77382f',
    baseUrl: 'https://api.callstack.ai/v1', codexUrl: 'https://api.callstack.ai/v1',
    cursorUrl: 'https://api.callstack.ai/v1', anthropicUrl: 'https://api.callstack.ai', appUrl: 'https://api.callstack.ai/v1',
    opencode: 'callstack.ai', pi: 'callstack', codex: 'callstack_ai',
  },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

// Whoever already has a key keeps their gateway; everyone else starts on Vercel AI Gateway.
export function defaultProvider(env = process.env) {
  const keyed = PROVIDER_IDS.filter(id => env[PROVIDERS[id].envVar]?.trim());
  return PROVIDERS[keyed.length === 1 ? keyed[0] : 'vercel'];
}
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
const OPENCODE_V2_PACKAGE = '@opencode/ai/providers/openai-compatible';
const OPENCODE_V2_MODEL = {
  name: 'Apex',
  capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
  limit: { context: CONTEXT_WINDOW, output: MAX_OUTPUT },
  settings: { reasoningEffort: 'medium' },
  variants: EFFORTS.map(effort => ({ id: effort, settings: { reasoningEffort: effort } })),
};
const PI_MODEL = {
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

// OpenCode 1 prints `1.18.34`, OpenCode 2 prints `opencode v2.0.29`, each on a line of its own,
// so a notice naming another version is not mistaken for it. Anything unreadable is treated as 1,
// the launch Apex CLI has always used.
export function openCodeMajor(binary) {
  if (!binary) return Promise.resolve(1);
  return new Promise(resolve => {
    execFile(binary, ['--version'], { timeout: 10000 }, (error, stdout) => {
      const match = !error && /^(?:opencode )?v?(\d+)\.\d+\.\d+\s*$/m.exec(stdout);
      resolve(match ? Number(match[1]) : 1);
    });
  });
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
// reference, so an upgrade never leaves someone without the key variable sending no key.
async function openCodeHasKey(authFile, providerId) {
  if (!authFile) return false;
  try { return Object.hasOwn(JSON.parse(await readConfig(authFile) ?? '{}'), providerId); }
  catch { return false; }
}
// 0.2 wrote this placeholder when no key was given, so it counts as no key.
const PI_PLACEHOLDER = 'XXX';

export async function planAssistant(assistant, provider = PROVIDERS.vercel) {
  const { model, envVar } = provider;
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
      const id = provider.opencode;
      const storedKey = await openCodeHasKey(assistant.authFile, id);
      await json(hasJsonc ? 'opencode.jsonc' : 'opencode.json', existing => {
        // The config says which format it is in; the binary is never run to ask. Anything not
        // already in the v2 shape gets v1, which OpenCode 2 still reads.
        v2 = Object.hasOwn(existing, 'providers');
        if (v2) return [
          [['providers', id, 'name'], provider.label],
          [['providers', id, 'package'], OPENCODE_V2_PACKAGE],
          [['providers', id, 'settings', 'baseURL'], provider.baseUrl],
          ...Object.entries(OPENCODE_V2_MODEL).map(([key, value]) =>
            [['providers', id, 'models', model, key], key === 'settings'
              ? { ...existing.providers?.[id]?.models?.[model]?.settings, ...value } : value]),
        ];
        return [
        [['provider', id, 'npm'], '@ai-sdk/openai-compatible'],
        [['provider', id, 'name'], provider.label],
        [['provider', id, 'options', 'baseURL'], provider.baseUrl],
        ...(storedKey || existing.provider?.[id]?.options?.apiKey
          ? [] : [[['provider', id, 'options', 'apiKey'], `{env:${envVar}}`]]),
        ...Object.entries(OPENCODE_MODEL).map(([key, value]) =>
          [['provider', id, 'models', model, key], key === 'options'
            ? { ...existing.provider?.[id]?.models?.[model]?.options, ...value } : value]),
        ];
      });
      // OpenCode 2 keeps provider keys in its own store, so the key is the one step left to you.
      if (v2) changes[0].steps = [`OpenCode 2 stores provider keys itself: run /connect in OpenCode, pick ${provider.label} → "Manually enter API Key", and paste ${provider.keyName}.`];
      break;
    }
    case 'pi': {
      const id = provider.pi;
      const entry = { id: model, ...PI_MODEL };
      await json('models.json', existing => {
        const models = existing.providers?.[id]?.models ?? [];
        const key = existing.providers?.[id]?.apiKey;
        if (!Array.isArray(models) || models.some(item => !item || typeof item.id !== 'string')) {
          throw new Error('Expected Pi models to be an array of model objects.');
        }
        return [
          [['providers', id, 'baseUrl'], provider.baseUrl],
          [['providers', id, 'api'], 'openai-completions'],
          ...(key && key !== PI_PLACEHOLDER ? [] : [[['providers', id, 'apiKey'], `$${envVar}`]]),
          // An Apex entry from an earlier setup is upgraded in place; other models keep their order.
          [['providers', id, 'models'], models.some(item => item.id === model)
            ? models.map(item => (item.id === model ? {
              ...item, ...entry,
              ...(item.compat ? { compat: Object.fromEntries(Object.entries(item.compat)
                .filter(([key]) => key !== 'reasoningEffortMap')) } : {}),
            } : item)) : [...models, entry]],
        ];
      });
      await json('settings.json', [[['modelThinkingLevels', `${id}/${model}`], 'medium']]);
      break;
    }
    case 'claude':
      await json('settings.json', [[['env', 'CLAUDE_CODE_ATTRIBUTION_HEADER'], '0']]);
      break;
    case 'codex': {
      const path = join(assistant.directory, `${provider.codex}.config.toml`);
      const before = await readConfig(path);
      const after = updateToml(before, {
        model_provider: provider.codex,
        model,
        model_context_window: CONTEXT_WINDOW,
        model_reasoning_effort: 'medium',
        model_providers: { [provider.codex]: {
          name: provider.label, base_url: provider.codexUrl, env_key: envVar,
          wire_api: 'responses', requires_openai_auth: false,
        } },
      }, path, ['model_max_output_tokens', 'model_auto_compact_token_limit']);
      changes.push({ path, before, after, format: 'toml' });
      break;
    }
  }
  return changes;
}

// The key a launch needs, so a missing one can be reported before anything else is checked.
export function launchToken(env, provider) {
  const token = env[provider.envVar];
  if (!token?.trim()) throw new Error(`Set ${provider.envVar} in your environment before launching with ${provider.name}.`);
  return token;
}

export function launchOptions(id, env = process.env, provider = defaultProvider(env), { openCode = 1 } = {}) {
  const { model } = provider;
  const token = launchToken(env, provider);
  const childEnv = { ...env };
  switch (id) {
    case 'opencode': {
      const selected = `${provider.opencode}/${model}`;
      if (openCode < 2) return { args: ['--model', selected], env: childEnv };
      // OpenCode 2's interface has no --model, and its shared background service never sees this
      // environment. A private server (--standalone) does: it reads the model from inline config,
      // and the gateway key the config references. Its flags only follow a subcommand.
      const inline = env.OPENCODE_CONFIG_CONTENT?.trim() ? parseJson(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT') : {};
      childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...inline, model: selected });
      return { args: ['--standalone'], env: childEnv, afterCommand: true, note: '(OPENCODE_CONFIG_CONTENT model set)' };
    }
    case 'codex': return { args: ['--profile', provider.codex], env: childEnv };
    case 'pi': return { args: ['--provider', provider.pi, '--model', model, '--thinking', 'medium'], env: childEnv };
    case 'claude':
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete childEnv[key];
      Object.assign(childEnv, {
        ANTHROPIC_BASE_URL: provider.anthropicUrl, ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_MODEL: model, CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CONTEXT_WINDOW),
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT),
      });
      return { args: ['--model', model], env: childEnv, note: '(ANTHROPIC_* gateway environment set)' };
    default: throw new Error(`Cannot launch ${id}. Use the editor's model selector.`);
  }
}

// What `apex run <id>` actually types for you, so the summary can show the command it replaces.
// The placeholder token is never shown: only the argument list and the launch's note are.
export function runExpansion(id, provider, installed = {}) {
  const { args, note } = launchOptions(id, { [provider.envVar]: 'placeholder' }, provider, installed);
  return [`${id} ${args.join(' ')}`, note].filter(Boolean).join('  ');
}

// One line per key: the whole object on one line cannot be folded to a terminal, and a step that
// wraps into the gutter loses its shape.
const copilotModel = provider => JSON.stringify({
  id: provider.model, name: 'Apex', url: provider.baseUrl, toolCalling: true, vision: true, thinking: true,
  contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT,
  supportsReasoningEffort: EFFORTS, reasoningEffortFormat: 'chat-completions',
}, null, 2);

// Kept to short lines, so the snippet is never folded out of shape.
const aiSdkSnippet = provider => [
  "import { createOpenAI } from '@ai-sdk/openai';",
  '',
  'const apex = createOpenAI({',
  "  name: 'callstack',",
  `  baseURL: '${provider.appUrl}',`,
  `  apiKey: process.env.${provider.envVar},`,
  '});',
  'const requestOptions = {',
  `  model: apex('${provider.model}'),`,
  `  maxOutputTokens: ${MAX_OUTPUT},`,
  '};',
  '// Pass requestOptions with your prompt to generateText / streamText.',
  `// Reasoning effort (${EFFORTS.join(', ')}):`,
  "// providerOptions: { callstack: { reasoningEffort: 'medium' } }",
];

export const MANUAL_IDS = ['cursor', 'copilot', 'ai-sdk'];
export function manualSteps(id, provider) {
  switch (id) {
    case 'cursor': return [
      `Cursor: Settings → Models → API Keys → OpenAI API Key. Enter ${provider.keyName}, override the base URL with ${provider.cursorUrl}, add and enable ${provider.model}, then select it in Agent.`,
      'Cursor has no way to declare what a custom model can do (tool calling, vision, reasoning); it infers that itself.',
    ];
    case 'copilot': return [
      `Installation of Copilot itself is not verified: Copilot → model selector → Manage Models → Add Models → Custom Endpoint → name ${provider.label} → enter ${provider.keyName} → Chat Completions.`,
      'Keep the generated apiKey secret reference; add this object to its models array:',
      ...copilotModel(provider).split('\n'),
    ];
    case 'ai-sdk': return [
      `Apex CLI never writes your key into a project. Keep it in ${provider.envVar} (for example in a .env that git ignores) and create the provider with:`,
      ...aiSdkSnippet(provider),
    ];
    default: throw new Error(`${id} is set up automatically.`);
  }
}
