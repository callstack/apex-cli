# Contributing

Requires Node.js 22+ and npm.

## Run from a checkout

```sh
npm ci
npm run build   # bundles dist/cli.js, which bin/apex.js runs
npm link        # puts `apex` on your PATH, pointing at this checkout
apex --help
apex detect
apex init --no-interactive   # preview only: prints the plan, writes nothing
apex init       # interactive: pick assistants, review, confirm
apex undo --no-interactive   # preview the reversal
```

`npm link` is the standard npm mechanism: `package.json` declares
`"bin": { "apex": "bin/apex.js" }`, so npm symlinks the command into your Node `bin`
directory (no sudo with nvm, no shell aliases, no `PATH` edits). Remove it with
`npm rm -g @callstack/apex`. You can also always run `node bin/apex.js …`. Rebuild after
changing `src/`.

## Tests and checks

```sh
npm test          # builds dist, then runs node:test against a throwaway HOME
npm run check     # syntax checks, build
npm pack --dry-run
```

CI runs `npm run check` and `npm test` on every pull request and push to `main`, on Linux with
Node 22, 24 and 26 and on macOS with Node 24 (`.github/workflows/ci.yml`).

Tests create a temporary `HOME`, fake credentials and a temporary state directory, so they never
touch your assistants' settings. One test asserts the published bundle imports nothing but `node:*`,
which is the point of bundling: `tsdown` inlines `@clack/prompts`, `jsonc-parser` and `smol-toml`
into a single `dist/cli.js` and the package ships with no runtime dependencies.

## Code layout

`src/` is deliberately small and each module owns one concept: `assistants.js` detection and the
per-tool adapters, `config.js` safe reads and JSONC/TOML edits, `diff.js` value and text diffs,
`secrets.js` the redaction rules, `journal.js` the undo journal, `plan.js` plan modelling and the
write flow, `ui.js` presentation, `paths.js` and `tty.js` the two environment probes, and `cli.js`
the command surface.

One table in `src/cli.js` defines every command and the flags it accepts, and `--help`, flag
parsing and the completion scripts are all generated from it, so none of the three can promise a
flag the others reject.

## Output conventions

Every Apex line sits in the same 3-space gutter the prompt library uses for its own text (`◇  …`,
`│  …`), so the picker, the plan and the diff below it read as one column; the header box sits just
outside that gutter, so its text lines up too. Blocks are separated by blank lines that headings own,
so nothing can slide out of alignment when a terminal wraps a line, and wrapped text stays inside the
gutter because widths are measured on the text without its colour codes. Columns inside a line are
sized from their longest value plus a gap, so labels never touch the text beside them. Added lines are
green, removals red, hunk markers magenta, the `callstack/Apex` model id is always green, and
environment references such as `{env:CALLSTACK_AUTH_TOKEN}` are highlighted instead of printed as
secrets. In `--help`, `apex` is green, the command plain and its options dim.

## Releasing

Before releasing, test each supported tool against a real account and verify version compatibility,
and try the packed tarball end to end (`npm pack`, then `npx --package ./callstack-apex-<version>.tgz
-- apex init` in a throwaway `HOME`).

The version in `package.json` must be new on npm: an interactive `npx @callstack/apex init` offers to
install exactly the version that is running, so a reused number would install something else.

Maintainers with publish access to `@callstack` release from an up-to-date `main`:

```sh
npm version minor   # or patch/major: bumps package.json, commits and tags
npm publish         # runs the tests, builds dist/, publishes publicly
git push --follow-tags
```

There is no separate build step: `npm publish` runs the tests first (`prepublishOnly`) and builds
`dist/` into the tarball (`prepack`), and stops if either fails.
