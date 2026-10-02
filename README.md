# tenore

**One `.agents/` source of truth, compiled into the native config of every AI coding agent.**

![status: work in progress](https://img.shields.io/badge/status-work%20in%20progress-orange)
![node: >=20.12](https://img.shields.io/badge/node-%3E%3D20.12-blue)
![license: MIT](https://img.shields.io/badge/license-MIT-green)
[![npm](https://img.shields.io/npm/v/tenore-cli)](https://www.npmjs.com/package/tenore-cli)

[Landing page](https://albz.it/tenore/) · [Mapping reference](docs/mapping.md) · [Roadmap](#roadmap)

## Why

Claude Code, Codex CLI and Antigravity each have their own format for
the same ideas: instructions, permissions, MCP servers, memory. You end up writing
your rules four times, they drift apart, and a permission tightened in one tool
stays wide open in another.

tenore keeps those rules in one place, as Markdown and YAML frontmatter, and
generates each tool's files from it. Switching agent becomes a 1:1 port.

## Install

```sh
npm install -g tenore-cli     # installs the `tenore` command
# or, without installing:
npx -y tenore-cli --help
```

The npm package is `tenore-cli` (npm reserves names too close to existing ones); the command
is always `tenore`. From source:

```sh
git clone https://github.com/AlbertoBarrago/tenore.git
cd tenore
npm install
npm run build
npm link        # puts `tenore` on your PATH
```

Runtime: Node >= 20.12. Running the test suite needs Node >= 22.12.

## Quick start

```sh
cd your-project
tenore init
```

In a terminal, `tenore init` is a short wizard: it finds existing agent config (CLAUDE.md,
AGENTS.md, `.claude/`, `.codex/`, ...), imports what you pick into `.agents/`, asks which agents
to generate files for, offers to update `.gitignore` and to register the memory and web MCP
servers, previews the sync and runs it. Nothing is written until you confirm, and it ends by
printing the equivalent commands, so you can script the same setup:

```sh
tenore init --import claude          # CLAUDE.md, .claude/settings*.json, .mcp.json -> .agents/
tenore init --import codex           # AGENTS.md, .codex/ -> .agents/
tenore init --targets claude,codex   # which agents to generate files for
tenore diff                          # what sync would write, as a unified diff
tenore sync                          # write the native files
```

`tenore init --yes` runs the wizard with every default (no TTY needed). Any other flag, or a
non-interactive shell, keeps the plain commands above. Your global setup works the same way with
`--global`: `tenore init --global` runs the same wizard on your personal config (`~/.claude`,
`~/.codex`, `~/.gemini` <-> `~/.agents/`) and shows the full diff before touching any of it.

## Source layout

```
~/.agents/              global scope
<repo>/.agents/         repo scope (committed)
  AGENTS.md             instructions, plain prose
  policy.md             frontmatter: permissions, mcp, overrides
  memory/*.md           persistent memory, one file per topic
  .lock                 hashes of generated files (committed)
<repo>/.agents/local/   local scope, same layout (gitignored)
```

Scopes merge from widest to narrowest: global, then repo, then local.

## policy.md

```yaml
---
# yaml-language-server: $schema=https://raw.githubusercontent.com/AlbertoBarrago/tenore/main/schema/policy.schema.json
targets: [claude, codex]       # optional: adapters to run (default: all implemented)
permissions:
  default: ask                 # allow | ask | deny
  allow:
    - shell: "npm run test*"   # glob on the command line
    - fs.write: "src/**"       # gitignore-style; inner "/" anchors at the scope root
    - mcp: "github.*"          # <server>.<tool> or <server>.*
  ask:
    - shell: "git push*"
  deny:
    - fs.read: ".env*"         # no inner "/": matches at any depth
    - network: none            # none | restricted | full
mcp:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${env:GITHUB_TOKEN}"   # translated, never resolved
overrides:
  claude:                      # verbatim, for what the IR cannot express
    permissions:
      allow: ["WebFetch(domain:docs.example.com)"]
---
```

The frontmatter is validated against [`schema/policy.schema.json`](schema/policy.schema.json),
generated from the zod schema in [`src/ir/schema.ts`](src/ir/schema.ts). Only
`${env:VAR}` placeholders are accepted; secrets stay references in every generated file.

## Merge rules

- **deny > ask > allow**, at any scope: a capability denied globally cannot be
  allowed by a repo, and a narrower deny also wins. Every rule dropped this way is
  reported as a warning.
- Lists concatenate in scope order and are deduplicated.
- Scalars (`default`, `targets`, same-name MCP servers) take the narrowest scope that sets them.
- `network` is one effective value: any deny locks it to the most restrictive
  denied level; otherwise the narrowest scope wins.
- Instructions and memory are concatenated in scope order, each block tagged with its source.

## Commands

| Command | What it does | Exit code |
|---|---|---|
| `tenore init` | Setup wizard in a terminal; otherwise scaffold `.agents/` (never overwrites) | 1 if cancelled |
| `tenore init --targets <ids>` | Set `targets` in policy.md (comma separated) | 1 on unknown ids |
| `tenore init --yes` | Run the wizard with every default | as `init` |
| `tenore init --import <claude\|codex\|antigravity> [--force]` | Pull an agent's existing config into `.agents/` | 1 if `.agents/` files would change without `--force` |
| `tenore sync` | Write generated files | 1 on drift or conflict |
| `tenore diff` | Dry-run `sync` as a unified diff | 0 |
| `tenore mcp [--global]` | Serve `.agents/` memory over MCP stdio: `memory_list`, `memory_read`, `memory_search`, `memory_write` | runs until stdin closes |
| `tenore check` | For CI: verify sources and generated files | 1 on schema errors, drift, conflict, or pending changes |

Common flags: `--root <dir>` (default: cwd), `--global` (include `~/.agents`),
`--target <ids...>` (default: `targets` from policy.md, else every implemented adapter),
`--prune` (remove untouched files of adapters that are no longer targets; without it they
are reported as `orphan` and kept).

## Web access through MCP (recommended: telemaco)

`network: none` closes each agent's *native* web tools (Claude `WebFetch`/`WebSearch`, Codex
web search and sandbox network, Antigravity `read_url`/`execute_url`). It does not touch MCP
servers, so web access can go through one MCP server you choose, governed by explicit `mcp`
rules and identical in every agent.

Any web or browser MCP server works. We recommend
[telemaco](https://github.com/AlbertoBarrago/telemaco), a lightweight headless browser built
for AI agents:

```sh
brew tap albertobarrago/telemaco && brew install telemaco
# or: curl -fsSL https://raw.githubusercontent.com/AlbertoBarrago/telemaco/main/install.sh | bash
```

Then declare it once in `.agents/policy.md` (or `~/.agents/policy.md` for every project):

```yaml
permissions:
  deny:
    - network: none            # no native web tools
  ask:
    - mcp: "telemaco.*"        # web only through telemaco, with confirmation
mcp:
  telemaco:
    command: telemaco
    args: ["mcp"]
```

Swap `telemaco` for any other server (name, command, args) and the same rules apply. On
Antigravity, permission rules are only read from the user settings, so put them in
`~/.agents/policy.md` and sync with `--global` to enforce them there too. Prefer
declaring the server here over `telemaco install`, which edits each agent's config directly:
tenore would then report those files as drifted. If you already ran it, `tenore init --import
<agent> --force` pulls the server into `.agents/`.

## Memory MCP server

`tenore mcp` lets any agent read and update the shared memory in `.agents/memory/` (and
`.agents/local/memory/`; `~/.agents/memory/` with `--global`). Register it once in
`.agents/policy.md` and `tenore sync` wires it into every target:

```yaml
mcp:
  tenore-memory:
    command: npx
    args: ["-y", "tenore-cli", "mcp"]
```

Writes are confined to the memory directories: topics are plain file names (no `/`, no `..`,
no dotfiles), bodies are capped at 64 KB, files are written atomically. After `memory_write`
creates a new topic, run `tenore sync` so each agent's generated files include it. The server
has no dependencies (minimal stdio JSON-RPC) and was checked with the official MCP Inspector
and Claude Code.

## Safety

- **Hand edits are never overwritten.** `.agents/.lock` stores the hash of every
  generated artifact. If a generated file changed since the last sync, `sync`
  reports drift and skips it; `tenore init --import claude --force` pulls the edit
  back into `.agents/`.
- **Foreign files are never overwritten.** An existing file tenore did not generate
  is a conflict until you import it.
- **Shared files are merged surgically.** In `.claude/settings*.json` only
  `permissions.{allow,ask,deny,defaultMode}` are owned; every other key is left as is.
- **Never widens permissions.** When a target cannot express a rule exactly, the
  more restrictive option is emitted with a warning (see [docs/mapping.md](docs/mapping.md)).
- **Atomic writes** (temp file and rename), file modes preserved.
- **Global config is opt-in:** `~/.claude/` is written only with `--global`.
- **The wizard writes nothing until you confirm**, and for `--global` it shows the full diff
  before touching `~/.claude`, `~/.codex` or `~/.gemini`. Cancelling leaves everything untouched.
- **No code in frontmatter:** `---js` style frontmatter is refused.

## Targets

| Target | Instructions | Permissions | MCP | Import | Status |
|---|---|---|---|---|---|
| Claude Code | `CLAUDE.md`, `CLAUDE.local.md` (via `@` imports) | `.claude/settings*.json` | `.mcp.json` (repo scope) | yes, round-trip tested | done |
| Codex CLI | `AGENTS.md`, `AGENTS.override.md` (copied, marked blocks) | `.codex/config.toml`, `.codex/rules/tenore.rules` | `config.toml` `[mcp_servers]` | yes, round-trip tested | done (fs rules via opt-in permission profiles) |
| Gemini CLI | | | | | dropped (replaced by Antigravity CLI for consumer plans, 2026-06-18) |
| Antigravity | `.agents/AGENTS.md` (native), always-on rules with `@[...]()` includes | `~/.gemini/antigravity-cli/settings.json` (user level only) | `.agents/mcp_config.json`, `~/.gemini/config/mcp_config.json` | yes, round-trip tested | done (no project-level permissions upstream) |

Every non-obvious mapping decision is a row in [docs/mapping.md](docs/mapping.md).

## Roadmap

- [x] Phase 1: canonical IR, parser, hierarchical merge
- [x] Phase 2: Claude Code adapter (emit, import, round-trip), CLI, lock and drift
- [x] Codex CLI adapter (instructions, approval policy, network, MCP, shell rules, import)
- [x] Codex filesystem rules via permission profiles (opt-in: `overrides.codex.permission_profiles: true`)
- [x] Antigravity adapter (rules, user permissions, MCP, import)
- [ ] ~~Gemini CLI adapter~~ dropped: Gemini CLI was replaced by Antigravity CLI
- [x] `tenore check` in CI (GitHub Action)
- [x] `targets` in policy.md, `--prune` for orphaned files
- [x] Memory MCP server (`tenore mcp`)
- [x] Setup wizard: `tenore init` for a repository, `tenore init --global` for your personal config

## Development

```sh
npm run build        # tsc -> dist/
npm run typecheck
npm run lint         # biome
npm test             # vitest
npx vitest run test/merge.test.ts   # one file
npm run gen:schema   # regenerate schema/policy.schema.json
```

Architecture: `parse` (one layer per scope) -> `merge` -> `Adapter.emit` per scope
-> `sync` (plan, lock, atomic write). Conventional Commits; each mapping decision
goes into `docs/mapping.md`.

## License

[MIT](LICENSE)
