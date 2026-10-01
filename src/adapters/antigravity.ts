import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isPlainObject } from "../ir/canonical.ts";
import type { Warning } from "../ir/diagnostics.ts";
import { INSTRUCTIONS_FILE, layerDirs, MEMORY_DIR } from "../ir/parse.ts";
import type { Ir, McpServer } from "../ir/schema.ts";
import { parseHeader, withHeader } from "../sync/hash.ts";
import { importAntigravity } from "./antigravity/import.ts";
import { antigravityPaths } from "./antigravity/paths.ts";
import { fromAntigravityRule, toAntigravityRules } from "./antigravity/permissions.ts";
import type { Adapter, Artifact, EmitContext } from "./types.ts";

export const OWNED_SETTINGS_KEYS = [
  "permissions.allow",
  "permissions.ask",
  "permissions.deny",
  "toolPermission",
] as const;

const ENV_REF = /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Antigravity (CLI and 2.0): repo instructions are read natively from
 * `.agents/AGENTS.md`; tenore adds an always-on rule that `@[...]()`-includes
 * memory (and the local layer), user-level permissions, and `mcp_config.json`.
 */
export const antigravity: Adapter = {
  id: "antigravity",

  expresses: {
    capability(cap, list, scope) {
      if (scope !== "global") return undefined;
      if ("network" in cap) {
        if (cap.network === "full") return undefined;
        return { list: cap.network === "none" ? "deny" : "ask", cap };
      }
      // Run the real mapping and its inverse, so this matches emit + import by construction.
      const home = "/__tenore_home__";
      const { rules } = toAntigravityRules({ allow: [], ask: [], deny: [], [list]: [cap] }, home);
      const rule = rules[list][0];
      const back = rule === undefined ? undefined : fromAntigravityRule(rule, home);
      return back ? { list, cap: back } : undefined;
    },
    server: (_name, server, scope) => {
      const converted = scope === "local" ? undefined : toAntigravityServer(server);
      return converted !== undefined && converted.inherited.length === 0;
    },
  },

  async detect(root) {
    for (const p of ["GEMINI.md", join(".agents", "rules"), join(".agents", "mcp_config.json")]) {
      if (await exists(join(root, p))) return true;
    }
    return false;
  },

  async emit(ir, ctx) {
    return compile(ir, ctx).artifacts;
  },

  import(root, ctx) {
    return importAntigravity(root, ctx);
  },

  lossy(ir, ctx) {
    return compile(ir, ctx).warnings;
  },
};

function compile(ir: Ir, ctx: EmitContext): { artifacts: Artifact[]; warnings: Warning[] } {
  const paths = antigravityPaths(ctx.scope, ctx.root, ctx.home);
  const artifacts: Artifact[] = [];
  const warnings: Warning[] = [];
  const raw = isPlainObject(ir.overrides.antigravity) ? ir.overrides.antigravity : {};

  const rules = rulesFile(ir, ctx, paths.rules, warnings);
  if (rules !== undefined) artifacts.push({ path: paths.rules, content: rules, strategy: "owned" });

  if (ctx.scope === "repo" && generatedRootAgentsMd(ctx.root)) {
    warnings.push({
      code: "antigravity-duplicate-instructions",
      message:
        "Antigravity reads both .agents/AGENTS.md and the root AGENTS.md generated for Codex: instructions appear twice in its context",
    });
  }

  const p = ir.permissions;
  const hasPermissions = p.allow.length + p.ask.length + p.deny.length > 0;
  if (paths.settings === undefined) {
    if (hasPermissions) {
      warnings.push({
        code: "antigravity-project-permissions-unsupported",
        message: `Antigravity reads permissions only from ~/.gemini/antigravity-cli/settings.json: ${ctx.scope} rules are NOT ENFORCED (declare them in ~/.agents/policy.md)`,
      });
    }
  } else {
    const settings = settingsFile(ir, ctx, raw, warnings);
    if (settings !== undefined) {
      artifacts.push({
        path: paths.settings,
        content: `${JSON.stringify(settings, null, 2)}\n`,
        strategy: { mergeKeys: [...OWNED_SETTINGS_KEYS] },
      });
    }
  }

  const servers = mcpServers(ir, raw, warnings);
  if (Object.keys(servers).length > 0) {
    if (paths.mcp === undefined) {
      warnings.push({
        code: "antigravity-mcp-scope-unsupported",
        message: "Antigravity has no local MCP config: local servers are not emitted",
      });
    } else {
      artifacts.push({
        path: paths.mcp,
        content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
        strategy: { mergeKeys: ["mcpServers"] },
      });
    }
  }
  return { artifacts, warnings };
}

/**
 * An always-on rule made of `@[label](path)` includes, which Antigravity
 * inlines itself. Repo instructions are left out (read natively); the global
 * and local layers have no native location, so their AGENTS.md is included.
 */
function rulesFile(
  ir: Ir,
  ctx: EmitContext,
  target: string,
  warnings: Warning[],
): string | undefined {
  const dir = layerDirs(ctx.root, ctx.home)[ctx.scope];
  const includes: { label: string; path: string; body: string }[] = [];
  if (ctx.scope !== "repo") {
    for (const block of ir.instructions.filter((i) => i.scope === ctx.scope)) {
      includes.push({ label: "instructions", path: block.source, body: block.body });
    }
  }
  for (const m of ir.memory.filter((x) => x.scope === ctx.scope)) {
    includes.push({ label: m.topic, path: join(dir, MEMORY_DIR, `${m.topic}.md`), body: m.body });
  }
  if (includes.length === 0) return undefined;

  const lines = includes.map(({ label, path, body }) => {
    const ref =
      ctx.scope === "global"
        ? `~/${toPosix(relative(ctx.home, path))}`
        : toPosix(relative(dirname(target), path));
    if (!/[\s()[\]]/.test(ref)) return `@[${label}](${ref})`;
    warnings.push({
      code: "antigravity-include-inlined",
      message: `"${path}" cannot be used in an @[...]() include; its content is inlined`,
      path,
    });
    return body.replace(/\n+$/, "");
  });
  const description = `tenore ${ctx.scope === "repo" ? "memory" : `${ctx.scope} instructions and memory`}, generated from ${toPosix(relative(ctx.scope === "global" ? ctx.home : ctx.root, dir))}/`;
  return withHeader(
    `trigger: always_on\ndescription: ${JSON.stringify(description)}\n---\n\n${lines.join("\n")}\n`,
    "frontmatter",
  );
}

function settingsFile(
  ir: Ir,
  ctx: EmitContext,
  raw: Record<string, unknown>,
  warnings: Warning[],
): Record<string, unknown> | undefined {
  const mapped = toAntigravityRules(ir.permissions, ctx.home);
  warnings.push(...mapped.warnings);
  const rawPerms = isPlainObject(raw.permissions) ? raw.permissions : {};
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const permissions: Record<string, string[]> = {};
  for (const list of ["allow", "ask", "deny"] as const) {
    const rules = [...new Set([...mapped.rules[list], ...strings(rawPerms[list])])];
    if (rules.length > 0) permissions[list] = rules;
  }

  let toolPermission: unknown;
  if (ctx.layer.policy.permissions?.default !== undefined) {
    const level = ir.permissions.default;
    if (level === "allow") {
      warnings.push({
        code: "antigravity-default-allow",
        message:
          'default "allow" has no safe Antigravity preset; toolPermission stays "request-review"',
      });
    }
    if (level === "deny") {
      warnings.push({
        code: "antigravity-default-deny",
        message:
          'default "deny" becomes toolPermission "strict" (prompts for every non-read tool instead of refusing)',
      });
    }
    toolPermission = level === "deny" ? "strict" : "request-review";
  }
  // Raw values (from import) fill gaps only; they never replace an explicit IR default.
  toolPermission ??= raw.toolPermission;

  const out: Record<string, unknown> = {};
  if (Object.keys(permissions).length > 0) out.permissions = permissions;
  if (toolPermission !== undefined) out.toolPermission = toolPermission;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Verified with agy 1.2.14: `mcp_config.json` values are passed literally (no
 * `${VAR}` expansion), but the server inherits agy's own environment. So
 * `KEY: ${env:KEY}` is expressed by leaving KEY out; a renamed or embedded
 * variable, or one in command/args, cannot be expressed and the server is
 * skipped. Secrets are never resolved into the file.
 */
function mcpServers(
  ir: Ir,
  raw: Record<string, unknown>,
  warnings: Warning[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(ir.mcp)) {
    const converted = toAntigravityServer(server);
    if (!converted) {
      warnings.push({
        code: "antigravity-mcp-env-unsupported",
        message: `MCP server "${name}" uses \${env:...} in command/args or renames a variable; Antigravity passes values literally, server not emitted`,
      });
      continue;
    }
    out[name] = converted.server;
  }
  if (isPlainObject(raw.mcpServers)) Object.assign(out, raw.mcpServers);
  return Object.fromEntries(
    Object.keys(out)
      .sort()
      .map((k) => [k, out[k]]),
  );
}

/** `inherited` lists the env keys left to inheritance (lost on import, so not an exact round-trip). */
export function toAntigravityServer(
  server: McpServer,
): { server: Record<string, unknown>; inherited: string[] } | undefined {
  if (ENV_REF.test(server.command) || (server.args ?? []).some((a) => ENV_REF.test(a)))
    return undefined;
  const env: Record<string, string> = {};
  const inherited: string[] = [];
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (value === `\${env:${key}}`) inherited.push(key);
    else if (ENV_REF.test(value)) return undefined;
    else env[key] = value;
  }
  return {
    server: {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    inherited,
  };
}

function generatedRootAgentsMd(root: string): boolean {
  const path = join(root, INSTRUCTIONS_FILE);
  if (!existsSync(path)) return false;
  try {
    return parseHeader(readFileSync(path, "utf8")) !== undefined;
  } catch {
    // Unreadable root AGENTS.md: no duplicate to report; sync reports real I/O errors on its own files.
    return false;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // access() signals absence (or no permission) only by throwing; both mean "not detected".
    return false;
  }
}
