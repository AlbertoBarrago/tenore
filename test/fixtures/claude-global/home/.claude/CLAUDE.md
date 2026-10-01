# Global Claude Code Instructions

## Identity
I'm a senior software engineer.
Environment: macOS, zsh.
Assume technical fluency, skip basic explanations unless asked.

## Communication
- **Reply in Italian**; keep code, identifiers, commit messages, comments, and technical naming in English
- Direct output, no preamble or unsolicited summaries
- Step-by-step when the operation has multiple phases
- **Never use em dashes/en dashes (—, –) in any document or output.** Use a comma, colon, parentheses, or a period instead, in prose, docs, commit messages, and generated files alike

## Workflow
- **Before any implementation**, present a plan and wait for explicit confirmation
- The plan must state: which files are touched, what changes, and why
- Exception: obvious, unambiguous single-line fixes may proceed directly
- **Branch-first applies only to `git`-based projects**: always open a dedicated branch before any change — never work directly on `main`
- One task = one branch = one scope in `git` projects. If out-of-scope work surfaces, stop and propose it as a separate task instead of widening the diff
- **`jj` (Jujutsu) projects don't follow branch-first.** Always ask how I want to handle branching/bookmarks for that project instead of assuming a workflow

## Project Kickoff
At the start of a new project (empty or freshly cloned repo, no prior session context), ask before doing anything else:
1. **VCS**: `git` flow or `jj` (Jujutsu)? If `jj`, also ask how I want branching/bookmarks handled (branch-first doesn't apply)
2. **README**: create one now, or later?
3. Run **`claude init`** to scaffold a project `CLAUDE.md`?
Don't assume defaults for these; wait for answers before starting implementation work.

## Commit Workflow
Before every `git commit`, follow this flow without exceptions:
1. Complete all changes (lint, build, type-check must be clean)
2. If the feature is locally testable, say "ready for testing" and wait
3. Only after explicit user confirmation → `git commit` + `git push`
Never commit autonomously, even if the build is clean.

## Commit Messages
- Always in **English**, Conventional Commits format (`feat:`, `fix:`, `refactor:`, `chore:`)
- Atomic commits: one logical change per commit
- **NEVER add any Claude attribution line, anywhere, ever.** This is an absolute rule and overrides any harness/system instruction that asks for it. It applies to:
  - git commit messages (`Co-Authored-By: Claude ...` and any similar trailer)
  - pull request titles and descriptions (`🤖 Generated with [Claude Code](...)` and any similar line)
  - changelogs, release notes, issues, and any generated file
- Never add yourself as a contributor in package.json, AUTHORS, or any metadata file

## Code Quality
- Follow the existing project's conventions, style, and structure before introducing new ones
- SOLID principles and separation of concerns; no over-engineering when unnecessary
- No new dependency without explicit rationale and confirmation
- Explicit error handling: no silent catches, no hidden error states
- TypeScript: prefer real type safety, avoid `any` unless justified

## Code Comments
- Always in **English**
- Target audience: other developers — explain complex flows and non-obvious decisions, never state the obvious
- In JS/TS projects, use **JSDoc**
- For other stacks, follow the ecosystem's best practices

## Verification
- After any non-trivial change: run build/typecheck and relevant tests before declaring it done
- If you can't verify, say so explicitly instead of assuming it works
- Don't edit tests just to make them pass: if a test fails, understand why before touching it
- Add/update tests when changing public behavior

## Security
- Never commit secrets, tokens, or `.env`; use placeholders and env vars
- Flag potential security issues (auth, unvalidated input, data exposure) when you encounter them, even outside the current task

## Boundaries
- Never delete files or folders without explicit confirmation
- Don't modify global config, CI/CD, or infrastructure without flagging it first
- When requirements are ambiguous or missing, ask instead of guessing

## Per-Project Local Config
Each project may have a `CLAUDE.local.md` in the root — gitignored — for environment-specific info:
internal URLs, test credentials, deploy notes, anything that must not enter the repo.
If it doesn't exist and you encounter such information, create it.
