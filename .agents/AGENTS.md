# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tenore` compiles a single source of truth in `.agents/` (Markdown + YAML frontmatter) into each coding agent's native config files (Claude Code now; Codex, Gemini, Antigravity are stubs). Goal: switching agent is a 1:1 port.

## Commands

```sh
npm run build        # tsc -p tsconfig.build.json -> dist/
npm run typecheck    # tsc --noEmit (src, test, scripts)
npm run lint         # biome check .
npm run format       # biome check --write .
npm test             # vitest run
npx vitest run test/merge.test.ts      # single file
npx vitest run -t "deny wins"          # single test by name
npm run gen:schema   # regenerate schema/policy.schema.json from the zod schema
node dist/cli.js <init|sync|check|diff>
```

Runtime target is Node >= 20 (`commander` pinned to v14 for that reason); dev tooling (vitest 5) needs Node >= 22.12. Imports use explicit `.ts` extensions (`rewriteRelativeImportExtensions`).

## Architecture

Pipeline: `parse` (one `.agents/` layer per scope) -> `merge` (global -> repo -> local) -> `Adapter.emit` -> `sync` (lock, drift check, atomic write).

- `src/ir/`: zod schema is the single definition of the IR and of `policy.md` frontmatter; the JSON Schema in `schema/` is generated from it, never hand-edited.
- Merge rules: deny > ask > allow at any scope; lists concat + dedupe by canonical key; scalars and same-name MCP servers: narrower scope wins; instructions/memory keep scope order and their `source`.
- `src/adapters/`: each adapter implements `detect/emit/import/lossy`. `emit(ir, ctx)` receives the scope in `ctx` because Claude writes different files per scope. Claude-specific rule string conversion lives in `src/adapters/claude/permissions.ts`.
- `src/sync/`: `.agents/.lock` (repo, committed), `.agents/local/.lock`, `~/.agents/.lock` hold path -> hash. On-disk hash != lock hash means a generated file was hand-edited: never overwrite, report drift.

## Invariants

- Never widen permissions silently: if a target cannot express a rule exactly, emit the more restrictive option plus a `Warning`.
- `${env:VAR}` values are never resolved into generated files.
- Claude `.claude/settings*.json` are merged on the `permissions` key only; other keys are untouched.
- Claude rules the IR cannot express go to `overrides.claude.permissions` verbatim so import -> sync -> import is lossless.
- Global scope (`~/.claude/`) is written only with an explicit `--global` flag.
- Every non-obvious mapping decision gets a row in `docs/mapping.md`.
