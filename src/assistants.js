import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { editJson, parseJson, readConfig, addToml } from './config.js';

// Apex is served by two gateways. Each one has its own model id, key and endpoints, and its own
// provider names in the configs, so switching gateways adds a provider instead of rewriting one.
const VERCEL = 'https://ai-gateway.vercel.sh';
export const PROVIDERS = {
  vercel: {
    id: 'vercel', name: 'Vercel AI Gateway', label: 'Vercel AI Gateway',
    model: 'callstack/apex', envVar: 'AI_GATEWAY_API_KEY', keyName: 'your Vercel AI Gateway API key',
    keysUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway&title=AI+Gateway',
    // The coding-agent surface is plain /v1 that tags the traffic; three agents have their own.
    baseUrl: `${VERCEL}/coding-agent/v1`, codexUrl: `${VERCEL}/codex/v1`,
    cursorUrl: `${VERCEL}/cursor/v1`, anthropicUrl: `${VERCEL}/claude-code`,
    opencode: 'apex-vercel', pi: 'apex-vercel', codex: 'apex_vercel',
  },
  callstack: {
    id: 'callstack', name: 'Callstack portal', label: 'callstack.ai',
    model: 'callstack/Apex', envVar: 'CALLSTACK_AUTH_TOKEN', keyName: 'your callstack.ai key',
    keysUrl: null,
    baseUrl: 'https://api.callstack.ai/v1', codexUrl: 'https://api.callstack.ai/v1',
    cursorUrl: 'https://api.callstack.ai/v1', anthropicUrl: 'https://api.callstack.ai',
    opencode: 'callstack.ai', pi: 'callstack', codex: 'callstack_ai',
  },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

// Whoever already has a key keeps their gateway; everyone else starts on Vercel AI Gateway.
export function defaultProvider(env = process.env) {
  const keyed = PROVIDER_IDS.filter(id => env[PROVIDERS[id].envVar]?.trim());
  return PROVIDERS[keyed.length === 1 ? keyed[0] : 'vercel'];
}
export const GUIDE_URL = 'https://app.notion.com/p/callstack/Apex-how-to-use-it-36d5d027c0f880e99d03d1c37a77382f';
export const IDS = ['opencode', 'codex', 'claude', 'pi', 'cursor', 'copilot'];
export const NAMES = {
  opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code', pi: 'Pi',
  cursor: 'Cursor', copilot: 'VS Code (Copilot)',
};
export const RUNNABLE = ['codex', 'claude', 'opencode', 'pi'];

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

export async function detect(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = locations(home, env, platform);
  return Promise.all(IDS.map(async id => {
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
    return { id, detected: Boolean(binary || found.length), binary, evidence: binary || found[0], directory: paths[id] };
  }));
}

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
      await json(hasJsonc ? 'opencode.jsonc' : 'opencode.json', existing => {
        if (Object.hasOwn(existing, 'providers')) throw new Error('OpenCode v2 providers format detected. This adapter targets the v1 provider format from the Callstack guide.');
        const key = ['provider', provider.opencode];
        return [
        [[...key, 'npm'], '@ai-sdk/openai-compatible'],
        [[...key, 'name'], provider.label],
        [[...key, 'options', 'baseURL'], provider.baseUrl],
        [[...key, 'options', 'apiKey'], `{env:${envVar}}`],
        [[...key, 'models', model, 'name'], 'Apex'],
        ];
      });
      break;
    }
    case 'pi':
      await json('models.json', existing => {
        const models = existing.providers?.[provider.pi]?.models ?? [];
        if (!Array.isArray(models) || models.some(model => !model || typeof model.id !== 'string')) {
          throw new Error('Expected Pi models to be an array of model objects.');
        }
        const key = ['providers', provider.pi];
        return [
          [[...key, 'baseUrl'], provider.baseUrl],
          [[...key, 'api'], 'openai-completions'],
          [[...key, 'apiKey'], `$${envVar}`],
          [[...key, 'models'], models.some(entry => entry.id === model) ? models : [...models, { id: model }]],
        ];
      });
      break;
    case 'claude':
      await json('settings.json', [[['env', 'CLAUDE_CODE_ATTRIBUTION_HEADER'], '0']]);
      break;
    case 'codex': {
      const path = join(assistant.directory, `${provider.codex}.config.toml`);
      const before = await readConfig(path);
      const after = addToml(before, {
        model_provider: provider.codex,
        model,
        model_providers: { [provider.codex]: {
          name: provider.label, base_url: provider.codexUrl, env_key: envVar,
          wire_api: 'responses', requires_openai_auth: false,
        } },
      }, path);
      changes.push({ path, before, after, format: 'toml' });
      break;
    }
  }
  return changes;
}

export function launchOptions(id, env = process.env, provider = defaultProvider(env)) {
  const { model, envVar } = provider;
  const token = env[envVar];
  if (!token?.trim()) throw new Error(`Set ${envVar} in your environment before launching with ${provider.name}.`);
  const childEnv = { ...env };
  switch (id) {
    case 'opencode': return { args: ['--model', `${provider.opencode}/${model}`], env: childEnv };
    case 'codex': return { args: ['--profile', provider.codex], env: childEnv };
    case 'pi': return { args: ['--provider', provider.pi, '--model', model], env: childEnv };
    case 'claude':
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete childEnv[key];
      Object.assign(childEnv, {
        ANTHROPIC_BASE_URL: provider.anthropicUrl, ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_MODEL: model, CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
      });
      return { args: ['--model', model], env: childEnv };
    default: throw new Error(`Cannot launch ${id}. Use the editor's model selector.`);
  }
}

// What `apex run <id>` actually types for you, so the summary can show the command it replaces.
// The placeholder token is never shown: only the argument list is part of the expansion.
const RUN_NOTE = { claude: '(ANTHROPIC_* gateway environment set)' };

export function runExpansion(id, provider) {
  const { args } = launchOptions(id, { [provider.envVar]: 'placeholder' }, provider);
  return [`${id} ${args.join(' ')}`, RUN_NOTE[id]].filter(Boolean).join('  ');
}

// One line per key: the whole object on one line cannot be folded to a terminal, and a step that
// wraps into the gutter loses its shape.
const copilotModel = provider => JSON.stringify(
  { id: provider.model, name: 'Apex', url: provider.baseUrl, toolCalling: true, vision: true }, null, 2);

export function manualSteps(id, provider) {
  if (id === 'cursor') {
    return [`Cursor: Settings → Models → API Keys → OpenAI API Key. Enter ${provider.keyName}, override the base URL with ${provider.cursorUrl}, add and enable ${provider.model}, then select it in Agent.`];
  }
  return [
    `Installation of Copilot itself is not verified: Copilot → model selector → Manage Models → Add Models → Custom Endpoint → name ${provider.label} → enter ${provider.keyName} → Chat Completions.`,
    'Keep the generated apiKey secret reference; add this object to its models array:',
    ...copilotModel(provider).split('\n'),
  ];
}
export const MANUAL_IDS = ['cursor', 'copilot'];
