# Capability mapping

How each IR construct is expressed by each target. Rule of thumb: when a target
cannot express a rule exactly, tenore emits the **more restrictive** option and
a `Warning` (visible in `tenore check` / `tenore sync`). Permissions are never
widened silently.

Claude Code syntax verified against <https://code.claude.com/docs/en/permissions>,
`/settings`, `/memory` and `/mcp` (October 2026). Codex syntax verified against
<https://learn.chatgpt.com/docs/config-file/config-reference>, `/agent-configuration/rules`,
`/agent-configuration/agents-md` and `/extend/mcp`, and against `codex execpolicy check`
(codex-cli 0.159). Antigravity syntax verified against
<https://antigravity.google/docs/permissions>, `/rules`, `/mcp` and `/cli/gcli-migration`
(agy 1.2.14; not exercised at runtime yet). Gemini CLI is dropped: it was replaced by
Antigravity CLI for consumer plans on 2026-06-18.

## Path globs (IR semantics)

IR path globs follow gitignore rules, relative to the scope root:

| IR glob | meaning |
|---|---|
| `.env*` (no inner `/`) | any file with that name, at any depth |
| `src/**` (inner `/`) | anchored at the scope root (repo root for repo/local) |
| `/etc/**` | absolute filesystem path |
| `~/.ssh/**` | relative to the home directory |

## Permissions

| capability | claude | codex | gemini | antigravity | notes |
|---|---|---|---|---|---|
| `{shell: g}` | `Bash(g)` | `prefix_rule(pattern = <tokens before the first wildcard>)`: ask -> `prompt`, deny -> `forbidden`; allow not emitted | dropped | `command(prefix)`, or `command(regex:...)` with one anchored regex per token; a `*` token that is not last broadens deny/ask to the prefix, drops allow; an exact glob allow is dropped (prefix match is wider) | 1:1. Claude `*` matches any text including spaces, like the IR glob. The legacy `:*` suffix is never emitted: `Bash(x:*)` equals `Bash(x *)`, which is narrower than `x*` (it would not match `x:unit`), so it would widen a deny on round-trip. |
| `{shell: "*"}` | `Bash` | not expressible (warning; a deny is NOT enforced) | dropped | `command(*)` | Bare tool name covers every command. |
| shell, compound commands | (same) | Codex splits plain `&&`/`||`/`;`/`|` chains and applies the strictest decision; scripts with expansions are matched as one `bash -lc` call | dropped | Antigravity prefix-matches each part of `&&`/`||`/`;`/`|` chains; substitutions and other hidden execution force a full-line match or Ask | Claude checks each subcommand of `a && b` / `a \| b` separately. For deny this is stricter than a glob on the whole line; for allow, a compound command needs every part allowed. |
| `{"fs.read": g}` | `Read(p)` | not emitted (needs beta permission profiles); a deny is NOT enforced, warning `codex-fs-unsupported` | dropped | `read_file(path)` (global scope only) | Read rules also gate Grep and Glob. |
| `{"fs.write": g}` | `Edit(p)` | same as fs.read | dropped | `write_file(path)` (global scope only) | Claude ignores `Write(...)` rules; Write and NotebookEdit are governed by `Edit`. |
| path `.env*` | `.env*` | n/a | dropped | `.env` stays root-only (warning `antigravity-fs-root-only`); a glob like `.env*` is NOT ENFORCED | Bare in Claude. Deny/ask match at any depth (same as IR). Allow matches only at cwd: narrower, so safe. |
| path `src/**` | `/src/**` | n/a | dropped | `src/` (recursive, relative to the workspace root) | Leading `/` anchors at the settings source, i.e. the project root for `.claude/settings*.json`. Bare `src/**` would be cwd-relative. |
| path `/etc/**` | `//etc/**` | n/a | dropped | `/etc/` | `//` is Claude's absolute prefix. |
| path `~/x` | `~/x` | n/a | dropped | `<home>/x` (expanded: user settings are per user) | Identical. |
| anchored path in **global** scope | allow/ask: dropped; deny: bare `p` | n/a | dropped | relative paths apply to every workspace root | User settings have no project root. Dropping an allow, or denying at any depth, is the restrictive fallback. Warning `claude-global-anchored-path`. |
| `{mcp: "s.t"}` | `mcp__s__t` | deny -> `disabled_tools`; ask -> `tools.t.approval_mode = "prompt"`; allow -> `"approve"` | dropped | `mcp(s/t)` | Server names may not contain `.` or `__` (schema), so the join is unambiguous. |
| `{mcp: "s.*"}` | `mcp__s` | deny -> `enabled = false`; ask/allow -> `default_tools_approval_mode = "prompt"` / `"approve"` | dropped | `mcp(s/*)` | Server-wide rule. `mcp__s__*` is also accepted on import. |
| `{network: "none"}` | deny `WebFetch`, `WebSearch` | `web_search = "disabled"`, `sandbox_workspace_write.network_access = false` | dropped | deny `read_url(*)`, `execute_url(*)` (also the sandbox network allowlist) | The level carries the meaning, whatever list it is in (merge keeps one effective value). Shell commands can still reach the network: warning `claude-network-shell-bypass`. Web access through an MCP server (e.g. telemaco) is governed by explicit `mcp` capabilities, not by `network`. |
| `{network: "restricted"}` | ask `WebFetch`, `WebSearch` | `web_search = "cached"`, `network_access = false` (warning) | dropped | ask `read_url(*)`, `execute_url(*)` | The IR has no domain allowlist; Claude `WebFetch(domain:x)` rules go in `overrides.claude.permissions`. Same shell warning. |
| `{network: "full"}` | (nothing) | (nothing) | dropped | (nothing) | |
| network, wider ask + narrower allow | ask stays | Codex merges user and project config natively, project wins | dropped | only the user settings file exists | Claude settings are emitted per scope and merged natively (deny > ask > allow across files), so a wider-scope ask still wins in Claude even where the merged IR says `full`. Stricter than the IR, never wider. |
| `default: ask` (explicit) | `defaultMode: "default"` | `approval_policy = "on-request"` | dropped | `toolPermission: "request-review"` | Emitted only when the layer sets `default`, so an unset repo default does not override the user's own mode. |
| `default: deny` | `defaultMode: "dontAsk"` | `approval_policy = "never"` | dropped | `toolPermission: "strict"` (prompts instead of refusing; warning) | `dontAsk` refuses anything not pre-allowed. |
| `default: allow` | `defaultMode: "default"` | `approval_policy = "on-request"` (warning `codex-default-allow`) | dropped | `toolPermission: "request-review"` (warning) | `bypassPermissions` would widen far beyond "allow by default". Warning `claude-default-allow`. |
| `overrides.claude.permissions.{allow,ask,deny}` | appended verbatim | n/a | n/a | n/a | Escape hatch and round-trip store for rules the IR cannot express (`WebFetch(domain:...)`, `Skill(...)`, cwd-relative paths). |
| `overrides.claude.permissions.defaultMode` | `defaultMode` verbatim | n/a | n/a | n/a | Wins over the mapped `default` (e.g. `auto`, `plan`, `acceptEdits`). |

## Files per scope (Claude)

| scope | instructions + memory | permissions | MCP |
|---|---|---|---|
| global (`--global` only) | `~/.claude/CLAUDE.md` with `@~/.agents/...` imports | `~/.claude/settings.json` | not emitted (lives in `~/.claude.json`), warning `claude-mcp-scope-unsupported` |
| repo | `CLAUDE.md` with `@.agents/...` imports | `.claude/settings.json` | `.mcp.json` (owned) |
| local | `CLAUDE.local.md` with `@.agents/local/...` imports | `.claude/settings.local.json` | not emitted (lives in `~/.claude.json`), same warning |

Settings files are merged on `permissions.allow`, `permissions.ask`,
`permissions.deny`, `permissions.defaultMode` only; every other key is left untouched.

## Instructions, memory, env

| construct | claude | codex | gemini | antigravity | notes |
|---|---|---|---|---|---|
| `AGENTS.md` | `@<relative path>` import | copied into `AGENTS.md` inside `tenore:begin/end` markers | dropped | not emitted for repo (read natively from `.agents/AGENTS.md`); global/local via an always-on rule with `@[...]()` includes | Claude resolves imports relative to the importing file, max 4 hops, and skips them inside code spans and fences. |
| `memory/<topic>.md` | `@<relative path>` import | copied, one marked block per topic | dropped | `@[topic](../memory/<topic>.md)` include in `.agents/rules/tenore-memory.md` | One import line per topic, in file-name order. |
| source path with whitespace | content inlined | n/a (always copied) | dropped | content inlined (warning `antigravity-include-inlined`) | `@` imports cannot contain whitespace. Warning `claude-import-inlined`. |
| `${env:VAR}` | `${VAR}` | `KEY: ${env:KEY}` -> `env_vars = ["KEY"]`; a renamed or embedded variable cannot be expressed: server skipped | dropped | not emitted: env expansion in `mcp_config.json` is unverified, server skipped (warning) | Claude expands `${VAR}` in `.mcp.json` at runtime. Never resolved by tenore. |

## Import (Claude to IR)

| Claude | IR | notes |
|---|---|---|
| hand-written `CLAUDE.md` / `CLAUDE.local.md` | one instruction block, verbatim | Text is never rewritten or split, so instruction semantics survive by construction. |
| generated `CLAUDE.md` (with header) | `@` imports resolved to `.agents/` sources | Imports outside the scope's `.agents/` become instruction blocks with warning `claude-import-foreign`; missing targets warn `claude-import-missing`. Inlined content becomes an instruction block of the generated file. |
| `Bash(x:*)` | `{shell: "x *"}` | Documented as equivalent; re-emitted as `Bash(x *)`. |
| `WebFetch` + `WebSearch` both in deny / ask | `{network: "none"}` / `{network: "restricted"}` in that list | Exactly what emit produces. Alone, or in allow, they stay raw. |
| (no web rules) | (no `network`) | `{network: "full"}` emits nothing, so it is indistinguishable from "unset" after a round-trip. Both mean no restriction. |
| `defaultMode: "default"` / `"dontAsk"` | `default: ask` / `default: deny` | Other modes (`auto`, `plan`, `acceptEdits`, `bypassPermissions`) go to `overrides.claude.permissions.defaultMode`. |
| `Edit(src/**)`, `Read(./x)`, `Read(/.env)`, `Write(...)`, `WebFetch(domain:...)`, `Skill(...)`, ... | `overrides.claude.permissions.<list>` verbatim | No exact IR form (cwd-relative or root-anchored single segment paths, tool-specific rules). |
| `.mcp.json` stdio server with `${VAR}` | `mcp.<name>` with `${env:VAR}` | |
| remote server, `${VAR:-default}`, name with `.` or `__` | `overrides.claude.mcpServers.<name>` verbatim | Re-emitted unchanged into `.mcp.json`. |
| literal value under a `*TOKEN*`/`*KEY*`/`*SECRET*`/`*PASSWORD*`/`*AUTH*` env key | imported, warning `mcp-literal-secret` | Move it to an env var. |
| settings keys other than `permissions.{allow,ask,deny,defaultMode}` | not imported | Left untouched on sync. |

## Files per scope (Codex)

| scope | instructions + memory | config (merged keys) | shell rules |
|---|---|---|---|
| global (`--global` only) | `~/.codex/AGENTS.md` | `~/.codex/config.toml` | `~/.codex/rules/tenore.rules` |
| repo | `AGENTS.md` | `.codex/config.toml` | `.codex/rules/tenore.rules` |
| local | `AGENTS.override.md` (repo + local blocks, gitignored) | none: local permissions and MCP are NOT applied, warning | none |

- Owned `config.toml` keys: `approval_policy`, `web_search`,
  `sandbox_workspace_write.network_access`, `mcp_servers` (whole table). Other keys are
  untouched; the file is rewritten (TOML comments lost) only when an owned key changes.
- `AGENTS.override.md` replaces `AGENTS.md` in Codex discovery, so it repeats the repo blocks.
- Codex loads project `.codex/` files only for trusted projects: warning `codex-project-trust`.
- `CODEX_HOME` is not honored yet: the global scope assumes `~/.codex`.

## Import (Codex to IR)

| Codex | IR | notes |
|---|---|---|
| hand-written `AGENTS.md` | one instruction block, verbatim | |
| generated `AGENTS.md` / `AGENTS.override.md` | blocks routed by their markers | Only blocks of the imported scope; text outside markers becomes an instruction block of the generated file. |
| `prefix_rule(pattern = [...], decision = "prompt" / "forbidden")` | ask / deny `{shell: "<prefix> *"}` | Only the exact generated form; other rules (unions, `allow`, extra fields) stay in `overrides.codex.rules` verbatim. |
| `approval_policy = "on-request"` / `"never"` | `default: ask` / `default: deny` | Other values (`granular`, ...) go to `overrides.codex.approval_policy`. |
| `web_search = "disabled"` + `network_access = false` | deny `{network: none}` | |
| `web_search = "cached"` + `network_access = false` | ask `{network: restricted}` | |
| other `web_search` / `network_access` | `overrides.codex.{web_search,network_access}` | Raw values only fill gaps: they never loosen an IR network rule. |
| stdio server with `env`, `env_vars`, `enabled`, `disabled_tools`, `prompt`/`approve` modes | `mcp.<name>` + `mcp` capabilities | Any other key (`url`, `cwd`, timeouts, `auto`/`writes`) keeps the whole server in `overrides.codex.mcp_servers`. |
| (`init --import codex` on an existing layer) | existing rules Codex cannot express are kept | fs rules, `allow` shell rules, globs broadened to a prefix, servers skipped for env reasons, other adapters' overrides. |

## Files per scope (Antigravity)

| scope | instructions + memory | permissions | MCP |
|---|---|---|---|
| global (`--global` only) | `~/.gemini/config/rules/tenore.md` (always-on, includes `~/.agents/AGENTS.md` and memory) | `~/.gemini/antigravity-cli/settings.json` (`permissions.{allow,ask,deny}`, `toolPermission`) | `~/.gemini/config/mcp_config.json` (`mcpServers`) |
| repo | `.agents/AGENTS.md` read natively; `.agents/rules/tenore-memory.md` includes memory | none: NOT ENFORCED, warning `antigravity-project-permissions-unsupported` | `.agents/mcp_config.json` (`mcpServers`) |
| local | `.agents/rules/tenore-local.md` (gitignored) includes `.agents/local/` | none: NOT ENFORCED | none |

- Antigravity also reads the root `AGENTS.md`. When the Codex adapter generates it, Antigravity sees the
  instructions twice (warning `antigravity-duplicate-instructions`).
- Generated rule files start with YAML frontmatter (required by Antigravity); the tenore header is a YAML
  comment on line 2.

## Import (Antigravity to IR)

| Antigravity | IR | notes |
|---|---|---|
| `.agents/AGENTS.md` | repo instructions | It is the tenore source itself. |
| hand-written `GEMINI.md`, root `AGENTS.md`, `~/.gemini/{AGENTS,GEMINI}.md` | instruction blocks, verbatim | Warning `antigravity-import-native-file`: remove the native file afterwards, or Antigravity reads it twice. |
| generated `tenore*.md` rule | includes resolved to `.agents/` sources | |
| `command(p)` / `command(regex:...)` | `{shell: "p *"}` / token glob | Only regexes tenore produces (escaped literals, `.*`, `.`); others stay raw. |
| `read_file(p)` / `write_file(p)` | `fs.read` / `fs.write`; `dir/` becomes `dir/**`, `<home>/x` becomes `~/x` | |
| `read_url(*)` + `execute_url(*)` in deny / ask | `network: none` / `restricted` | Domain rules, `unsandboxed(...)`, `mcp(*)` stay in `overrides.antigravity.permissions`. |
| `toolPermission: "request-review"` / `"strict"` | `default: ask` / `default: deny` | Other presets go to `overrides.antigravity.toolPermission`. |
| stdio server with literal `env` | `mcp.<name>` | `serverUrl`, `cwd`, headers, any `${` keep the server raw. |
