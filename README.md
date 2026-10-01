# tenore

**One `.agents/` source of truth, compiled into the native config of every AI coding agent.**

![status: work in progress](https://img.shields.io/badge/status-work%20in%20progress-orange)
![node: >=20](https://img.shields.io/badge/node-%3E%3D20-blue)
![license: MIT](https://img.shields.io/badge/license-MIT-green)

[Landing page](https://albz.it/tenore/) · [Mapping reference](docs/mapping.md) · [Roadmap](#roadmap)

## Why

Claude Code, Codex CLI and Antigravity each have their own format for
the same ideas: instructions, permissions, MCP servers, memory. You end up writing
your rules four times, they drift apart, and a permission tightened in one tool
stays wide open in another.

tenore keeps those rules in one place, as Markdown and YAML frontmatter, and
generates each tool's files from it. Switching agent becomes a 1:1 port.

## Install

Not published to npm yet. From source:

```sh
git clone https://github.com/AlbertoBarrago/tenore.git
cd tenore
npm install
npm run build
npm link        # puts `tenore` on your PATH
```

Runtime: Node >= 20. Running the test suite needs Node >= 22.12.

## Quick start

New repository:

```sh
tenore init     # scaffolds .agents/ and gitignores the local scope
$EDITOR .agents/AGENTS.md .agents/policy.md
tenore diff     # what sync would write, as a unified diff
tenore sync     # writes CLAUDE.md, AGENTS.md, .claude/settings.json, .codex/config.toml, ...
```

Already using Claude Code:

```sh
tenore init --import claude   # CLAUDE.md, settings and .mcp.json -> .agents/
tenore diff
tenore sync                   # native files are now generated from .agents/
```

Your global setup works the same way with `--global` (`~/.claude/` <-> `~/.agents/`).

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
| `tenore init` | Scaffold `.agents/`; never overwrites existing files | 0 |
| `tenore init --import <claude\|codex\|antigravity> [--force]` | Pull an agent's existing config into `.agents/` | 1 if `.agents/` files would change without `--force` |
| `tenore sync` | Write generated files | 1 on drift or conflict |
| `tenore diff` | Dry-run `sync` as a unified diff | 0 |
| `tenore mcp [--global]` | Serve `.agents/` memory over MCP stdio: `memory_list`, `memory_read`, `memory_search`, `memory_write` | runs until stdin closes |
| `tenore check` | For CI: verify sources and generated files | 1 on schema errors, drift, conflict, or pending changes |

Common flags: `--root <dir>` (default: cwd), `--global` (include `~/.agents`),
`--target <ids...>` (default: `targets` from policy.md, else every implemented adapter),
`--prune` (remove untouched files of adapters that are no longer targets; without it they
are reported as `orphan` and kept).

## Memory MCP server

`tenore mcp` lets any agent read and update the shared memory in `.agents/memory/` (and
`.agents/local/memory/`; `~/.agents/memory/` with `--global`). Register it once in
`.agents/policy.md` and `tenore sync` wires it into every target:

```yaml
mcp:
  tenore-memory:
    command: npx
    args: ["-y", "tenore", "mcp"]
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
- [ ] npm publish

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
