# Apex CLI

A CLI for configuring coding assistants to use Apex, Callstack's coding model.

`apex init` asks which gateway serves Apex, detects the assistants on your machine, lets you pick
which ones to configure, shows every change it wants to make, and only then writes. Nothing
changes until you say so.

## Gateways

| Gateway | `--provider` | Model | Key |
| --- | --- | --- | --- |
| Vercel AI Gateway | `vercel` | `callstack/apex` | `AI_GATEWAY_API_KEY` |
| Callstack portal | `callstack` | `callstack/Apex` | `CALLSTACK_AUTH_TOKEN` |

`apex init` asks which one to use. Without `--provider`, the default is the gateway whose key is
already set in your shell, and Vercel AI Gateway when neither or both are. `apex detect` and
`apex run` pick the gateway the same way, so `apex run codex` launches whatever you set up last as
long as only that key is exported. Each gateway gets its own provider entry in every config, so
switching gateways adds a provider next to the old one instead of rewriting it.

## Install

Requires Node.js 22+ and npm. Nothing to install first:

```sh
npx @callstack/apex init
```

An npx run leaves no `apex` command behind, so after setup it offers to install the same version
globally (`npm install -g @callstack/apex`), which is what makes `apex undo` and `apex run codex`
work later; the rest of this README uses that short form. Say no, or run non-interactively, and
every next step Apex CLI prints is spelled `npx @callstack/apex …` instead. Uninstalling does not
undo your configs, so run `apex undo` first if you want them back.

## Commands

| Command | What it does | Writes by default? |
| --- | --- | --- |
| `apex detect [--json]` | Finds assistants on `PATH`, in config directories and in macOS `/Applications`; shows what would change | No, never |
| `apex init` | Interactive setup: multiselect of detected assistants, colourised change preview, confirmation | Only after you confirm |
| `apex init --no-interactive` | Prints the plan without asking questions | No |
| `apex init --apply` | Writes the planned changes without asking | Yes |
| `apex undo` | Reverts the most recent Apex CLI setup, with the same preview and confirmation | Only after you confirm |
| `apex undo --list` | Shows recorded setups and which are already undone (`--json` prints the journal) | No |
| `apex run [--provider <id>] <assistant> [-- <args>]` | Launches the assistant with the gateway, model and credentials in the child environment | No |
| `apex completion <zsh\|bash\|fish>` | Prints a shell completion script | No |

Each command accepts only its own flags, and `--help` and the shell completions list exactly those:

| Command | Flags |
| --- | --- |
| `init` | `--assistants <ids>`, `--provider <id>`, `--no-interactive`, `--apply`, `--no-diff`, `--json`, `--help` |
| `detect` | `--provider <id>`, `--json`, `--help` |
| `run` | `--provider <id>`, right before or after the assistant |
| `undo` | `--no-interactive`, `--apply`, `--no-diff`, `--json`, `--list`, `--help` |

`apex init --wat` fails fast, and so does a flag in the wrong command
(`apex detect --no-diff`). Only `--apply` writes, so there is no "preview *and* write" to argue
about. `--assistants <ids>` is a comma list of `opencode`, `codex`,
`claude`, `pi`, `cursor`, `copilot`. `--provider <id>` is `vercel` or `callstack`.

Non-interactive callers (`--no-interactive`, `--json`, pipes, CI) never get a prompt and never
have files changed unless they also pass `--apply`. `--json` prints a machine-readable plan with
`mode`, `provider`, `model`, `envVar`, `applied`, `appliedPaths`, per-file `changes` and `nextSteps` instead of the human UI. If a
write fails halfway through a batch, the payload still reports what already landed plus the `error`,
and the exit code is 1.

### Shell completion

```sh
apex completion zsh  > "${fpath[1]}/_apex"                          # then rehash
apex completion bash >> ~/.bashrc                                   # then source ~/.bashrc
apex completion fish > ~/.config/fish/completions/apex.fish
```

## What a review looks like

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ Apex CLI · Configure Apex for your favorite harness                        │
 │                                                                            │
 │ Nothing is written until you confirm.                                      │
 └────────────────────────────────────────────────────────────────────────────┘
│
◇  Which gateway should your assistants use for Apex?
│  Vercel AI Gateway
│
◇  Set up callstack/apex for which assistants?  (space toggles, enter confirms)
│  OpenCode, Codex


   Planned changes:

   Update     ~/.config/opencode/opencode.json
   --- ~/.config/opencode/opencode.json
   +++ ~/.config/opencode/opencode.json
   @@ -1,4 +1,19 @@
    {
      // keep this comment
   -  "theme": "dark"
   +  "theme": "dark",
   +  "provider": {
   +    "apex-vercel": { … }
   +  }
    }

   Create     ~/.codex/apex_vercel.config.toml
   --- /dev/null
   +++ ~/.codex/apex_vercel.config.toml
   @@ -0,0 +1,10 @@
   +model_provider = "apex_vercel"

   Existing files get a .apex-backup-<id> copy first.        (dimmed)
│
◇  Apply these changes?
   ✔ ~/.config/opencode/opencode.json backup: opencode.json.apex-backup-b4c42657


   Environment

   ✓ AI_GATEWAY_API_KEY is set in this shell
   Apex CLI never reads, stores or logs the key itself.


   Use these commands to run callstack/apex with your selected harnesses:

   apex run opencode  opencode --model apex-vercel/callstack/apex         (dimmed)
   apex run codex     codex --profile apex_vercel

   ...or pick "callstack/apex" from the UI when setting up manually.
   For more instructions, visit: https://vercel.com/docs/ai-gateway/coding-agents

   If you want to undo the changes, run apex undo
```
`Environment` only shows the `export AI_GATEWAY_API_KEY=…` line (and, for Vercel AI Gateway, where to
create a key) while the variable is missing; once it is set you get a green
`✓ AI_GATEWAY_API_KEY is set in this shell` instead. The Callstack portal shows `CALLSTACK_AUTH_TOKEN`. The closing block shows
what each `apex run` expands to, links the gateway's guide (Vercel's coding-agents docs or the Callstack portal guide; the URL is never
folded, so it stays clickable), and
mentions `apex undo` only when something was actually written.

The diff is the change list: it only shows the lines that actually move, paths are shortened to
`~/…`, and values under keys like `apiKey`, `token` or `secret` are redacted, so a preview can be
pasted into a ticket safely. A file Apex CLI created diffs from `/dev/null`, and one it is deleting
diffs to `/dev/null`. `--no-diff` swaps the diff for one `+ key  value` row per setting.

## Reversing changes

`apex undo` re-applies the inverse of the last setup, named by the time it ran: files Apex CLI
created are deleted, files it edited go back to their pre-setup bytes. It only touches a file whose current content still hashes
to what Apex CLI wrote; anything you edited afterwards is left alone and reported. A setup whose
remaining files can only be left alone does not block the older ones: the next `apex undo` moves on
to the most recent setup that still has something to restore. Restores create
their own backup first, so an undo is itself reversible. Apex CLI records each batch in
`$APEX_STATE_DIR/journal.json` (default `~/.local/state/apex/journal.json`, mode `0600`); the last
20 batches are kept. Deleting the journal only forgets the history, it never changes a config.

## Integrations

Names below are Vercel AI Gateway / Callstack portal.

| Assistant | Configuration | Behavior |
| --- | --- | --- |
| OpenCode v1 | `~/.config/opencode/opencode.json` or `.jsonc` | Adds `provider.apex-vercel` / `provider.callstack.ai`, OpenAI-compatible transport, model and environment-key reference; preserves the default model. |
| Codex 0.134.0+ | `~/.codex/apex_vercel.config.toml` / `callstack_ai.config.toml` | Adds a self-contained Responses API provider/profile (Vercel's Codex endpoint `/codex/v1`); leaves base config and default model untouched. |
| Claude Code | `~/.claude/settings.json` | Merges attribution flag only; use `apex run claude` for gateway credentials and model selection (Vercel's Claude Code endpoint `/claude-code`). |
| Pi | `~/.pi/agent/models.json` | Adds `providers.apex-vercel` / `providers.callstack` with Chat Completions, Apex and `$AI_GATEWAY_API_KEY` / `$CALLSTACK_AUTH_TOKEN`; preserves other models. Requires a Pi version supporting `$VAR` key interpolation. |
| Cursor | Guided setup | Prints endpoint (Vercel's Cursor endpoint `/cursor/v1`), API-key and custom-model steps; does not modify private editor storage. |
| VS Code / Copilot | Guided setup | Detects VS Code, not whether Copilot is installed; prints custom-endpoint steps and model JSON, retaining the editor-generated secret reference. |

Respects `XDG_CONFIG_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`,
`XDG_STATE_HOME`/`APEX_STATE_DIR`, and Windows `APPDATA`. Project-specific settings and custom
`OPENCODE_CONFIG` files are not modified and may override global configuration. OpenCode's v2
`providers` format is not supported; this adapter uses the v1 `provider` format. Older Codex
releases using inline `[profiles]` need a manual migration or a newer Codex release.

Windows: file configuration supports Windows paths, but `apex run` refuses `.cmd`/`.bat` shims to
avoid shell interpolation; launch the configured assistant directly or use WSL.

## Authentication

Provide `AI_GATEWAY_API_KEY` (Vercel AI Gateway) or `CALLSTACK_AUTH_TOKEN` (Callstack portal)
through your shell or a secret manager. Create a Vercel key on the AI Gateway page of your Vercel
dashboard. Apex CLI never prompts for, logs, stores or validates the key, and never writes it to a
config file; configs only reference it. A hidden prompt keeps it out of your shell history:

```bash
read -r -s -p 'AI Gateway API key: ' AI_GATEWAY_API_KEY; echo
export AI_GATEWAY_API_KEY
apex run codex
```

With both keys exported, `apex run` uses Vercel AI Gateway; pass `--provider callstack` for the
portal: `apex run --provider callstack codex`.

Other launchers: `apex run opencode`, `apex run claude`, `apex run pi`, `apex run codex -- --help`.
Launchers pass extra arguments through unchanged (without a shell), can be overridden by explicit
user arguments, and never run `init`. `apex run claude` sets the gateway URL, token, attribution
flag and model aliases in the child process only, leaving your default Claude provider alone.

## Safety and recovery

Apex CLI will not break what you already have.

- It shows every change first, and writes nothing until you say yes. If you script it, only
  `--apply` writes.
- It copies a file next to itself before it edits that file, so you can always put the old one back.
- It keeps your comments, your other settings, and your default model.
- It never asks for your API key, writes it down, or sends it anywhere. You keep it in
  `AI_GATEWAY_API_KEY` or `CALLSTACK_AUTH_TOKEN`, and the CLI prints `<redacted>` wherever a secret would show.
- If a config file is broken, set up another way, or a link to somewhere else, Apex CLI stops and
  tells you. It does not overwrite it.
- `apex undo` gives your old setup back. It only touches files that still match what Apex CLI wrote.

How that works underneath:

- Previews print paths and key/value changes, never secrets.
- All selected configurations are parsed before any write. Malformed files, conflicting Codex
  profile keys and symlinked files or directories are refused, and one bad assistant blocks the
  whole batch instead of half-applying it.
- JSON/JSONC edits preserve comments and unrelated keys. Existing Apex endpoint and auth
  fields are replaced with the documented endpoint and environment references; existing auth files
  are left untouched, so a stored credential may still win and needs removal in the assistant's
  own auth UI.
- Writes use same-directory temporary files plus rename with mode `0600` (new directories `0700`),
  and abort if the file changed on disk between planning and saving. This is not a lock or a
  multi-file transaction: a later I/O failure can leave earlier writes applied. `apex undo`
  cleans that up.
- Backups and newly created files are printed with every save. To recover by hand, close the
  assistant and restore the printed `*.apex-backup-<id>` file over its config after reviewing any
  intervening edits. Backups can contain previous secrets.
- No shell startup file is ever edited. The CLI makes no API requests and cannot verify your
  key or gateway access; launch a configured assistant to test the connection.

## Configuration references

- Official Codex advanced configuration: `https://developers.openai.com/codex/config-advanced/`
  (separate profile files for 0.134.0+; provider is placed in that profile).
- OpenCode v1 configuration: `https://dev.opencode.ai/docs/config/`
  (JSONC and `{env:VARIABLE}` support).
- Vercel AI Gateway for coding agents: `https://vercel.com/docs/ai-gateway/coding-agents`
  (per-agent endpoints; Apex is listed as `callstack/apex`).
- Pi custom models: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md`
  (`$VARIABLE` key interpolation; bare uppercase names are literals in current docs).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
