import { access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isPlainObject } from "../ir/canonical.ts";
import type { Warning } from "../ir/diagnostics.ts";
import { layerDirs, MEMORY_DIR } from "../ir/parse.ts";
import type { Ir, McpServer, Scope } from "../ir/schema.ts";
import { withHeader } from "../sync/hash.ts";
import { importClaude } from "./claude/import.ts";
import { claudePaths } from "./claude/paths.ts";
import { type ClaudeRules, toClaudeRules } from "./claude/permissions.ts";
import type { Adapter, Artifact, EmitContext } from "./types.ts";

/** Paths inside `permissions` that tenore owns; everything else in settings is left alone. */
export const OWNED_PERMISSION_KEYS = [
  "permissions.allow",
  "permissions.ask",
  "permissions.deny",
  "permissions.defaultMode",
] as const;

export const claude: Adapter = {
  id: "claude",

  async detect(root) {
    for (const p of ["CLAUDE.md", ".claude", ".mcp.json", "CLAUDE.local.md"]) {
      if (await exists(join(root, p))) return true;
    }
    return false;
  },

  async emit(ir, ctx) {
    return compile(ir, ctx).artifacts;
  },

  import(root, ctx) {
    return importClaude(root, ctx);
  },

  lossy(ir, ctx) {
    return compile(ir, ctx).warnings;
  },
};

/** Single pass that produces both the artifacts and what could not be expressed exactly. */
function compile(ir: Ir, ctx: EmitContext): { artifacts: Artifact[]; warnings: Warning[] } {
  const paths = claudePaths(ctx.scope, ctx.root, ctx.home);
  const artifacts: Artifact[] = [];
  const warnings: Warning[] = [];

  const memory = memoryFile(ir, ctx, paths.memory, warnings);
  if (memory !== undefined)
    artifacts.push({ path: paths.memory, content: memory, strategy: "owned" });

  const settings = settingsFile(ir, ctx, warnings);
  if (settings !== undefined) {
    artifacts.push({
      path: paths.settings,
      content: json(settings),
      strategy: { mergeKeys: [...OWNED_PERMISSION_KEYS] },
    });
  }

  const rawServers = isPlainObject(ir.overrides.claude?.mcpServers)
    ? ir.overrides.claude.mcpServers
    : {};
  const servers = [...Object.keys(ir.mcp), ...Object.keys(rawServers)];
  if (servers.length > 0) {
    if (paths.mcp === undefined) {
      // Claude keeps user and local MCP servers in ~/.claude.json, a large
      // state file tenore does not write. Skipping a server never widens access.
      warnings.push({
        code: "claude-mcp-scope-unsupported",
        message: `${ctx.scope} MCP servers (${servers.join(", ")}) are not emitted for Claude; declare them in the repo .agents/policy.md`,
      });
    } else {
      artifacts.push({
        path: paths.mcp,
        content: json(mcpFile(ir.mcp, rawServers)),
        strategy: "owned",
      });
    }
  }
  return { artifacts, warnings };
}

/**
 * CLAUDE.md that imports the sources instead of copying them, so the
 * `.agents/` files stay the only place to edit. A path Claude cannot import
 * (whitespace in it) is inlined instead, with a warning.
 */
function memoryFile(
  ir: Ir,
  ctx: EmitContext,
  target: string,
  warnings: Warning[],
): string | undefined {
  const scoped = <T extends { scope: Scope }>(xs: T[]) => xs.filter((x) => x.scope === ctx.scope);
  const instructions = scoped(ir.instructions);
  const memory = scoped(ir.memory);
  if (instructions.length === 0 && memory.length === 0) return undefined;

  const memoryDir = join(layerDirs(ctx.root, ctx.home)[ctx.scope], MEMORY_DIR);
  const sections = [
    instructions.map((i) => importLine(i.source, i.body, target, ctx, warnings)),
    memory.map((m) => importLine(join(memoryDir, `${m.topic}.md`), m.body, target, ctx, warnings)),
  ].filter((lines) => lines.length > 0);
  return withHeader(`${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`);
}

function importLine(
  source: string,
  body: string,
  target: string,
  ctx: EmitContext,
  warnings: Warning[],
): string {
  const ref = importRef(source, target, ctx);
  if (!/\s/.test(ref)) return `@${ref}`;
  warnings.push({
    code: "claude-import-inlined",
    message: `"${source}" contains whitespace and cannot be @-imported; its content is inlined`,
    path: source,
  });
  return body.replace(/\n+$/, "");
}

/** Relative to the importing file (Claude's rule); `~/` form for the global CLAUDE.md. */
function importRef(source: string, target: string, ctx: EmitContext): string {
  if (ctx.scope === "global") return `~/${toPosix(relative(ctx.home, source))}`;
  return toPosix(relative(dirname(target), source));
}

function settingsFile(ir: Ir, ctx: EmitContext, warnings: Warning[]): object | undefined {
  const mapped = toClaudeRules(ir.permissions, ctx.scope);
  warnings.push(...mapped.warnings);

  const raw = rawOverrides(ir.overrides.claude);
  const rules: ClaudeRules = {
    allow: merged(mapped.rules.allow, raw.allow),
    ask: merged(mapped.rules.ask, raw.ask),
    deny: merged(mapped.rules.deny, raw.deny),
  };

  let defaultMode: string | undefined;
  if (ctx.layer.policy.permissions?.default !== undefined) {
    const level = ir.permissions.default;
    if (level === "allow") {
      // bypassPermissions would also skip deny-less safety prompts: never widen silently.
      warnings.push({
        code: "claude-default-allow",
        message:
          'default "allow" has no safe Claude equivalent; Claude keeps prompting ("default" mode)',
      });
      defaultMode = "default";
    } else {
      defaultMode = level === "deny" ? "dontAsk" : "default";
    }
  }
  defaultMode = raw.defaultMode ?? defaultMode;

  const permissions: Record<string, unknown> = {};
  for (const key of ["allow", "ask", "deny"] as const) {
    if (rules[key].length > 0) permissions[key] = rules[key];
  }
  if (defaultMode !== undefined) permissions.defaultMode = defaultMode;
  return Object.keys(permissions).length > 0 ? { permissions } : undefined;
}

/**
 * `overrides.claude.permissions` holds rules the IR cannot express (e.g.
 * `WebFetch(domain:x)`), emitted verbatim after the mapped ones.
 */
function rawOverrides(claudeOverrides: Record<string, unknown> | undefined): {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: string;
} {
  const perms = isPlainObject(claudeOverrides?.permissions) ? claudeOverrides.permissions : {};
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const out = { allow: list(perms.allow), ask: list(perms.ask), deny: list(perms.deny) };
  return typeof perms.defaultMode === "string" ? { ...out, defaultMode: perms.defaultMode } : out;
}

function merged(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** `${env:VAR}` becomes Claude's `${VAR}`: translated, never resolved. */
export function toClaudeEnv(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
}

/**
 * `raw` holds servers the IR cannot express (remote transports,
 * `${VAR:-default}`), stored verbatim by import under `overrides.claude.mcpServers`.
 */
function mcpFile(servers: Record<string, McpServer>, raw: Record<string, unknown>): object {
  const mcpServers: Record<string, unknown> = { ...raw };
  for (const [name, s] of Object.entries(servers)) {
    mcpServers[name] = {
      type: "stdio",
      command: toClaudeEnv(s.command),
      ...(s.args ? { args: s.args.map(toClaudeEnv) } : {}),
      ...(s.env
        ? { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, toClaudeEnv(v)])) }
        : {}),
    };
  }
  return {
    mcpServers: Object.fromEntries(
      Object.keys(mcpServers)
        .sort()
        .map((k) => [k, mcpServers[k]]),
    ),
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // access() only signals absence (or no permission) by throwing; both mean "not detected".
    return false;
  }
}
