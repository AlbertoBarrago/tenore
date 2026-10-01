import { join } from "node:path";
import { isPlainObject } from "../../ir/canonical.ts";
import { SourceError, type Warning } from "../../ir/diagnostics.ts";
import { readText } from "../../ir/parse.ts";
import {
  type Capability,
  type InstructionBlock,
  MCP_SERVER_NAME,
  type McpServer,
  McpServerSchema,
  type MemoryBlock,
  type PermissionLevel,
  type Policy,
} from "../../ir/schema.ts";
import { parseHeader } from "../../sync/hash.ts";
import { parseDocument } from "../../sync/write.ts";
import type { ImportContext, ImportResult } from "../types.ts";
import { parseBlocks } from "./instructions.ts";
import { codexPaths } from "./paths.ts";
import { parseRules, prefixToCapability } from "./rules.ts";

type Lists = Record<PermissionLevel, Capability[]>;

/**
 * Reads Codex native files for one scope back into a layer. Like the Claude
 * importer, anything without an exact IR form is kept verbatim under
 * `overrides.codex` so a later sync writes it back unchanged.
 */
export async function importCodex(root: string, ctx: ImportContext): Promise<ImportResult> {
  const paths = codexPaths(ctx.scope, root, ctx.home);
  const warnings: Warning[] = [];
  const base = ctx.scope === "global" ? ctx.home : root;
  const { instructions, memory } = await importInstructions(paths.instructions, base, ctx);

  const lists: Lists = { allow: [], ask: [], deny: [] };
  const policy: Policy = {};
  const raw: Record<string, unknown> = {};

  if (paths.rules) {
    const text = await readText(paths.rules);
    if (text !== undefined) {
      const generated = parseHeader(text);
      const parsed = parseRules(generated ? generated.body : text);
      for (const rule of parsed.rules) {
        const { list, cap } = prefixToCapability(rule);
        lists[list].push(cap);
      }
      if (parsed.rest !== "") raw.rules = parsed.rest;
    }
  }

  if (paths.config) {
    const text = await readText(paths.config);
    if (text !== undefined) {
      let config: Record<string, unknown>;
      try {
        config = parseDocument("toml", text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SourceError([
          { path: paths.config, at: "", message: `invalid TOML: ${message}` },
        ]);
      }
      importConfig(config, lists, policy, raw, warnings, paths.config);
    }
  }

  const permissions: NonNullable<Policy["permissions"]> = { ...(policy.permissions ?? {}) };
  for (const list of ["allow", "ask", "deny"] as const) {
    if (lists[list].length > 0) permissions[list] = lists[list];
  }
  if (Object.keys(permissions).length > 0) policy.permissions = permissions;
  if (Object.keys(raw).length > 0) policy.overrides = { codex: raw };
  return { instructions, memory, policy, warnings };
}

/**
 * Generated files are split on their block markers; only blocks of this scope
 * are taken (the local override also carries repo blocks). A hand-written file
 * is one verbatim instruction block.
 */
async function importInstructions(
  path: string,
  base: string,
  ctx: ImportContext,
): Promise<{ instructions: InstructionBlock[]; memory: MemoryBlock[] }> {
  const text = await readText(path);
  if (text === undefined) return { instructions: [], memory: [] };
  const generated = parseHeader(text);
  if (!generated)
    return { instructions: [{ source: path, scope: ctx.scope, body: text }], memory: [] };

  const blocks = parseBlocks(generated.body);
  const instructions: InstructionBlock[] = blocks.instructions
    .filter((b) => b.scope === ctx.scope)
    .map((b) => ({ source: join(base, b.ref), scope: ctx.scope, body: b.body }));
  if (blocks.loose !== "")
    instructions.push({ source: path, scope: ctx.scope, body: blocks.loose });
  const memory = blocks.memory.filter((m) => m.scope === ctx.scope);
  return { instructions, memory };
}

function importConfig(
  config: Record<string, unknown>,
  lists: Lists,
  policy: Policy,
  raw: Record<string, unknown>,
  warnings: Warning[],
  path: string,
): void {
  const approval = config.approval_policy;
  if (approval === "on-request") policy.permissions = { default: "ask" };
  else if (approval === "never") policy.permissions = { default: "deny" };
  else if (approval !== undefined) raw.approval_policy = approval;

  // Exactly what emit writes for network none/restricted; anything else stays raw.
  const sandbox = isPlainObject(config.sandbox_workspace_write)
    ? config.sandbox_workspace_write
    : {};
  const networkAccess = sandbox.network_access;
  const webSearch = config.web_search;
  if (networkAccess === false && webSearch === "disabled") {
    lists.deny.push({ network: "none" });
  } else if (networkAccess === false && webSearch === "cached") {
    lists.ask.push({ network: "restricted" });
  } else {
    if (webSearch !== undefined) raw.web_search = webSearch;
    if (typeof networkAccess === "boolean") raw.network_access = networkAccess;
  }

  if (config.mcp_servers === undefined) return;
  if (!isPlainObject(config.mcp_servers)) {
    throw new SourceError([{ path, at: "mcp_servers", message: "expected a table" }]);
  }
  const servers: Record<string, McpServer> = {};
  const rawServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.mcp_servers)) {
    const converted = MCP_SERVER_NAME.test(name) ? fromCodexServer(name, server, lists) : undefined;
    if (converted) servers[name] = converted;
    else rawServers[name] = server;
    if (isPlainObject(server) && isPlainObject(server.env))
      flagLiteralSecrets(name, server.env, warnings, path);
  }
  if (Object.keys(servers).length > 0) policy.mcp = servers;
  if (Object.keys(rawServers).length > 0) raw.mcp_servers = rawServers;
}

const KNOWN_SERVER_KEYS = new Set([
  "command",
  "args",
  "env",
  "env_vars",
  "enabled",
  "disabled_tools",
  "default_tools_approval_mode",
  "tools",
]);

/**
 * Converts a stdio server whose every key has an IR form; its tool policy
 * becomes `mcp` capabilities. Any other key (url, cwd, timeouts, `auto` /
 * `writes` modes, ...) keeps the whole server raw, so nothing is half-imported.
 */
function fromCodexServer(name: string, server: unknown, lists: Lists): McpServer | undefined {
  if (!isPlainObject(server)) return undefined;
  if (Object.keys(server).some((k) => !KNOWN_SERVER_KEYS.has(k))) return undefined;

  const caps: { list: PermissionLevel; cap: Capability }[] = [];
  if (server.enabled === false) caps.push({ list: "deny", cap: { mcp: `${name}.*` } });
  else if (server.enabled !== undefined && server.enabled !== true) return undefined;

  if (server.disabled_tools !== undefined) {
    if (!isStringArray(server.disabled_tools)) return undefined;
    for (const t of server.disabled_tools)
      caps.push({ list: "deny", cap: { mcp: `${name}.${t}` } });
  }
  const mode = modeToList(server.default_tools_approval_mode);
  if (mode === null) return undefined;
  if (mode) caps.push({ list: mode, cap: { mcp: `${name}.*` } });

  if (server.tools !== undefined) {
    if (!isPlainObject(server.tools)) return undefined;
    for (const [tool, settings] of Object.entries(server.tools)) {
      if (!isPlainObject(settings) || Object.keys(settings).some((k) => k !== "approval_mode"))
        return undefined;
      const list = modeToList(settings.approval_mode);
      if (!list) return undefined;
      caps.push({ list, cap: { mcp: `${name}.${tool}` } });
    }
  }

  const env: Record<string, string> = {};
  if (server.env !== undefined) {
    if (!isPlainObject(server.env)) return undefined;
    for (const [k, v] of Object.entries(server.env)) {
      // A literal "${" would be read back as a placeholder: keep such servers raw.
      if (typeof v !== "string" || v.includes("${")) return undefined;
      env[k] = v;
    }
  }
  if (server.env_vars !== undefined) {
    if (!isStringArray(server.env_vars)) return undefined;
    for (const k of server.env_vars) env[k] = `\${env:${k}}`;
  }

  const parsed = McpServerSchema.safeParse({
    command: server.command,
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  if (!parsed.success) return undefined;
  for (const { list, cap } of caps) lists[list].push(cap);
  return parsed.data;
}

/** `undefined`: not set; `null`: a mode with no IR form (auto, writes). */
function modeToList(mode: unknown): PermissionLevel | undefined | null {
  if (mode === undefined) return undefined;
  if (mode === "prompt") return "ask";
  if (mode === "approve") return "allow";
  return null;
}

const SECRET_KEY = /TOKEN|SECRET|PASSWORD|KEY|AUTH/i;

function flagLiteralSecrets(
  name: string,
  env: Record<string, unknown>,
  warnings: Warning[],
  path: string,
): void {
  for (const [key, v] of Object.entries(env)) {
    if (SECRET_KEY.test(key) && typeof v === "string" && v !== "") {
      warnings.push({
        code: "mcp-literal-secret",
        message: `${name}.env.${key} looks like a literal secret; use \${env:${key}} in .agents/policy.md`,
        path,
      });
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
