# Apex CLI

Configures the AI coding assistants on your machine to use
[Callstack Apex](https://apex.callstack.com/) (`callstack/Apex`).

`apex init` detects the assistants on your machine, lets you pick which ones to configure,
shows every change it wants to make, and only then writes. Nothing changes until you say so.

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
| `apex run <assistant> [-- <args>]` | Launches the assistant with the gateway, model and credentials in the child environment | No |
| `apex completion <zsh\|bash\|fish>` | Prints a shell completion script | No |

Each command accepts only its own flags, and `--help` and the shell completions list exactly those:

| Command | Flags |
| --- | --- |
| `init` | `--assistants <ids>`, `--no-interactive`, `--apply`, `--no-diff`, `--json`, `--help` |
| `detect` | `--json`, `--help` |
| `undo` | `--no-interactive`, `--apply`, `--no-diff`, `--json`, `--list`, `--help` |

`apex init --wat` fails fast, and so does a flag in the wrong command
(`apex detect --no-diff`). Only `--apply` writes, so there is no "preview *and* write" to argue
about. `--assistants <ids>` is a comma list of `opencode`, `codex`,
`claude`, `pi`, `cursor`, `copilot`, `ai-sdk`.

Non-interactive callers (`--no-interactive`, `--json`, pipes, CI) never get a prompt and never
have files changed unless they also pass `--apply`. `--json` prints a machine-readable plan with
`mode`, `applied`, `appliedPaths`, per-file `changes` and `nextSteps` instead of the human UI. If a
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
 │ Apex CLI · Configure callstack/Apex for your favorite harness              │
 │                                                                            │
 │ Nothing is written until you confirm.                                      │
 └────────────────────────────────────────────────────────────────────────────┘
│
◆  Set up callstack/Apex for which assistants?  (space toggles, enter confirms)
│  OpenCode, Codex
│
◇  Set up callstack/Apex for which assistants?  (space toggles, enter confirms)
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
   +    "callstack.ai": { … }
   +  }
    }

   Create     ~/.codex/callstack_ai.config.toml
   --- /dev/null
   +++ ~/.codex/callstack_ai.config.toml
   @@ -0,0 +1,10 @@
   +model_provider = "callstack_ai"

   Existing files get a .apex-backup-<id> copy first.        (dimmed)
│
◇  Apply these changes?
   ✔ ~/.config/opencode/opencode.json backup: opencode.json.apex-backup-b4c42657


   Environment

   ✓ CALLSTACK_AUTH_TOKEN is set in this shell
   Apex CLI never reads, stores or logs the key itself.


   Use these commands to run callstack/Apex with your selected harnesses:

   apex run opencode  opencode --model callstack.ai/callstack/Apex        (dimmed)
   apex run codex     codex --profile callstack_ai

   ...or pick "callstack/Apex" from the UI when setting up manually.
   For more instructions, visit:
   https://app.notion.com/p/callstack/Apex-how-to-use-it-36d5d027c0f880e99d03d1c37a77382f

   If you want to undo the changes, run apex undo
```
`Environment` only shows the `export CALLSTACK_AUTH_TOKEN=…` line while the variable is missing; once
it is set you get a green `✓ CALLSTACK_AUTH_TOKEN is set in this shell` instead. The closing block shows
what each `apex run` expands to, links the guide (the URL is never folded, so it stays clickable), and
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

| Assistant | Configuration | Behavior |
| --- | --- | --- |
| OpenCode | `~/.config/opencode/opencode.json` or `.jsonc` | Adds `provider.callstack.ai`, OpenAI-compatible transport, model and environment-key reference; preserves the default model. A config already in OpenCode 2's `providers` format gets the v2 entry instead, and you add the key with `/connect`. |
| Codex 0.134.0+ | `~/.codex/callstack_ai.config.toml` | Adds a self-contained Responses API provider/profile; leaves base config and default model untouched. |
| Claude Code | `~/.claude/settings.json` | Merges attribution flag only; use `apex run claude` for gateway credentials and model selection. |
| Pi | `~/.pi/agent/models.json` and `settings.json` | Adds `providers.callstack` with Chat Completions, Apex and `$CALLSTACK_AUTH_TOKEN`; saves `medium` as Apex's per-model thinking default for direct launches. Preserves other models and their defaults. Requires a Pi version supporting `$VAR` key interpolation and `modelThinkingLevels`. |
| Cursor | Guided setup | Prints endpoint, API-key and custom-model steps; does not modify private editor storage. |
| VS Code / Copilot | Guided setup | Detects VS Code, not whether Copilot is installed; prints custom-endpoint steps and model JSON, retaining the editor-generated secret reference. |
| Vercel AI SDK / Eve | Guided setup | Detected from the `package.json` in the directory you run Apex CLI from (`ai`, `@ai-sdk/openai` or `eve`); prints the connector snippet, which reads the key from `CALLSTACK_AUTH_TOKEN`. Nothing is written into the project. |

Apex configs declare tool calling, image input, and the supported
`none`/`low`/`medium`/`xhigh` reasoning efforts (default `medium`) where supported.
OpenCode, Pi, Copilot, Claude's launcher, and the AI SDK guidance retain a 32,768-token output
budget. OpenCode, Pi, Codex, Copilot, and Claude's launcher declare the model's native
262,144-token context window using each app's documented fields. Input limits and compaction
thresholds use the harness defaults; Apex CLI does not set a separate input budget or compaction
reserve.
Pi's per-model default applies to fresh direct launches and model selection; `apex run pi` also
selects `medium` explicitly. Resumed Pi sessions retain their saved thinking level.

The gateway model ID, authentication, `medium` default, and `off` → `none` translation remain
Callstack-specific.

| Harness | Context field | Output field | Official reference |
| --- | --- | --- | --- |
| OpenCode | `limit.context` | `limit.output` | [Custom providers](https://opencode.ai/docs/providers/) |
| Pi | `contextWindow` | `maxTokens` | [Custom models](https://pi.dev/docs/latest/models) |
| Codex | `model_context_window` | No output-limit config key | [OpenAI configuration reference](https://developers.openai.com/codex/config-reference/) |
| Claude Code launcher | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | [Environment variables](https://code.claude.com/docs/en/env-vars) |
| VS Code / Copilot | `contextWindow` | `maxOutputTokens` | [Custom endpoint models](https://code.visualstudio.com/docs/agent-customization/language-models) |

The Claude launcher sets context/output limits only in the child process and does not set compaction
window or percentage controls. Pi retains its native compaction settings. The AI SDK
snippet sets the output budget without inventing a context-window option.

Run `apex init` again after updating the CLI to preview upgrades to an existing Apex setup; pass
`--apply` to save them. Apex context/output metadata and reasoning mappings are updated in place. Older OpenCode input
limits and Codex compaction overrides are removed so each harness uses its own compaction defaults.
Codex's obsolete `model_max_output_tokens` key from older Apex versions is removed, and its dedicated
profile becomes self-contained. Unrelated settings, models, credentials and comments are preserved;
the ordinary backups and `apex undo` also cover upgrades. `none` remains supported: the gateway
translates it to thinking off.

Respects `XDG_CONFIG_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`,
`XDG_STATE_HOME`/`APEX_STATE_DIR`, and Windows `APPDATA`. Project-specific settings and custom
`OPENCODE_CONFIG` files are not modified and may override global configuration. A new OpenCode
config is written in the v1 format, which OpenCode 2 also reads. Older Codex
releases using inline `[profiles]` need a manual migration or a newer Codex release.

Windows: file configuration supports Windows paths, but `apex run` refuses `.cmd`/`.bat` shims to
avoid shell interpolation; launch the configured assistant directly or use WSL.

## Authentication

Provide `CALLSTACK_AUTH_TOKEN` through your shell or a secret manager. Apex CLI never prompts for,
logs, stores or validates the key, and never writes it to a config file; configs only reference it.
A hidden prompt keeps it out of your shell history:

```bash
read -r -s -p 'Callstack API key: ' CALLSTACK_AUTH_TOKEN; echo
export CALLSTACK_AUTH_TOKEN
apex run codex
```

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
  `CALLSTACK_AUTH_TOKEN`, and the CLI prints `<redacted>` wherever a secret would show.
- If a config file is broken, set up another way, or a link to somewhere else, Apex CLI stops and
  tells you. It does not overwrite it.
- `apex undo` gives your old setup back. It only touches files that still match what Apex CLI wrote.

How that works underneath:

- Previews print paths and key/value changes, never secrets.
- All selected configurations are parsed before any write. Malformed files and symlinked files or
  directories are refused, and one bad assistant blocks the
  whole batch instead of half-applying it.
- The dedicated Codex Apex profile's owned keys are upgraded rather than rejected as conflicts;
  the base `config.toml` and other profiles remain untouched.
- JSON/JSONC edits preserve comments and unrelated keys. The Callstack endpoint is set to the
  documented one. A key the assistant already has (in OpenCode's own key store, or in Pi's
  `models.json`, where Apex CLI 0.2 put them) is kept, so upgrading never leaves an assistant
  without a key; otherwise the config references `CALLSTACK_AUTH_TOKEN`.
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
- Pi custom models: `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md`
  (`$VARIABLE` key interpolation; bare uppercase names are literals in current docs).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
