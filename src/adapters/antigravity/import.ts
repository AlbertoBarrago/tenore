import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isPlainObject } from "../../ir/canonical.ts";
import { SourceError, type Warning } from "../../ir/diagnostics.ts";
import { INSTRUCTIONS_FILE, layerDirs, MEMORY_DIR, readText } from "../../ir/parse.ts";
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
import type { ImportContext, ImportResult } from "../types.ts";
import { antigravityPaths } from "./paths.ts";
import { fromAntigravityRule, URL_ACTIONS } from "./permissions.ts";

/**
 * Reads Antigravity native files for one scope back into a layer; anything
 * without an exact IR form goes to `overrides.antigravity` verbatim.
 */
export async function importAntigravity(root: string, ctx: ImportContext): Promise<ImportResult> {
  const paths = antigravityPaths(ctx.scope, root, ctx.home);
  const layerDir = layerDirs(root, ctx.home)[ctx.scope];
  const warnings: Warning[] = [];
  const instructions: InstructionBlock[] = [];
  const memory: MemoryBlock[] = [];

  // The repo layer's AGENTS.md is Antigravity's own native file.
  if (ctx.scope === "repo") {
    const source = join(layerDir, INSTRUCTIONS_FILE);
    const body = await readText(source);
    if (body !== undefined) instructions.push({ source, scope: ctx.scope, body });
  }

  const rulesText = await readText(paths.rules);
  const generated = rulesText === undefined ? undefined : parseHeader(rulesText);
  if (generated) {
    const parsed = await parseIncludes(generated.body, paths.rules, layerDir, ctx, warnings);
    instructions.push(...parsed.instructions);
    memory.push(...parsed.memory);
  }

  for (const path of [
    ...paths.handWritten,
    ...(ctx.scope === "repo" ? [join(root, INSTRUCTIONS_FILE)] : []),
  ]) {
    const body = await readText(path);
    if (body === undefined || parseHeader(body)) continue;
    instructions.push({ source: path, scope: ctx.scope, body });
    warnings.push({
      code: "antigravity-import-native-file",
      message: `${path} was imported into .agents/; remove it after checking, or Antigravity will read it twice`,
      path,
    });
  }

  const policy: Policy = {};
  const raw: Record<string, unknown> = {};
  if (paths.settings) {
    const settings = await readJson(paths.settings);
    if (settings) importSettings(settings, policy, raw, ctx.home, paths.settings);
  }
  if (paths.mcp) {
    const config = await readJson(paths.mcp);
    if (config) importMcp(config.mcpServers, policy, raw, paths.mcp);
  }
  if (Object.keys(raw).length > 0) policy.overrides = { antigravity: raw };
  return { instructions, memory, policy, warnings };
}

/** Resolves the `@[label](path)` lines written by emit back to their sources. */
async function parseIncludes(
  body: string,
  rulesPath: string,
  layerDir: string,
  ctx: ImportContext,
  warnings: Warning[],
): Promise<{ instructions: InstructionBlock[]; memory: MemoryBlock[] }> {
  const instructions: InstructionBlock[] = [];
  const memory: MemoryBlock[] = [];
  const end = body.indexOf("\n---\n");
  const content = end === -1 ? body : body.slice(end + 5);
  const loose: string[] = [];

  for (const line of content.split("\n")) {
    const m = /^@\[[^\]]*\]\(([^)\s]+)\)$/.exec(line);
    if (!m?.[1]) {
      loose.push(line);
      continue;
    }
    const ref = m[1];
    const target = ref.startsWith("~/")
      ? join(ctx.home, ref.slice(2))
      : isAbsolute(ref)
        ? ref
        : resolve(dirname(rulesPath), ref);
    const text = await readText(target);
    if (text === undefined) {
      warnings.push({
        code: "antigravity-include-missing",
        message: `${line} points to a missing file`,
        path: rulesPath,
      });
      continue;
    }
    if (dirname(target) === join(layerDir, MEMORY_DIR) && target.endsWith(".md")) {
      memory.push({ topic: basename(target, ".md"), scope: ctx.scope, body: text });
    } else {
      if (target !== join(layerDir, INSTRUCTIONS_FILE)) {
        warnings.push({
          code: "antigravity-include-foreign",
          message: `${line} is outside ${layerDir}`,
          path: rulesPath,
        });
      }
      instructions.push({ source: target, scope: ctx.scope, body: text });
    }
  }
  const rest = loose.join("\n").trim();
  if (rest !== "") instructions.push({ source: rulesPath, scope: ctx.scope, body: `${rest}\n` });
  return { instructions, memory };
}

function importSettings(
  settings: Record<string, unknown>,
  policy: Policy,
  raw: Record<string, unknown>,
  home: string,
  path: string,
): void {
  const permissions: NonNullable<Policy["permissions"]> = {};
  const rawPerms: Partial<Record<PermissionLevel, string[]>> = {};
  const perms = settings.permissions;
  if (perms !== undefined && !isPlainObject(perms)) {
    throw new SourceError([{ path, at: "permissions", message: "expected an object" }]);
  }

  for (const list of ["allow", "ask", "deny"] as const) {
    const rules = isPlainObject(perms) ? perms[list] : undefined;
    if (rules === undefined) continue;
    if (!Array.isArray(rules) || !rules.every((r) => typeof r === "string")) {
      throw new SourceError([
        { path, at: `permissions.${list}`, message: "expected an array of strings" },
      ]);
    }
    const unique = [...new Set(rules)];
    const network = list !== "allow" && URL_ACTIONS.every((r) => unique.includes(r));
    const caps: Capability[] = [];
    const unmapped: string[] = [];
    let networkAdded = false;
    for (const rule of unique) {
      if (network && (URL_ACTIONS as readonly string[]).includes(rule)) {
        if (!networkAdded) caps.push({ network: list === "deny" ? "none" : "restricted" });
        networkAdded = true;
        continue;
      }
      const cap = fromAntigravityRule(rule, home);
      if (cap) caps.push(cap);
      else unmapped.push(rule);
    }
    if (caps.length > 0) permissions[list] = caps;
    if (unmapped.length > 0) rawPerms[list] = unmapped;
  }

  const preset = settings.toolPermission;
  if (preset === "request-review") permissions.default = "ask";
  else if (preset === "strict") permissions.default = "deny";
  else if (preset !== undefined) raw.toolPermission = preset;

  if (Object.keys(permissions).length > 0) policy.permissions = permissions;
  if (Object.keys(rawPerms).length > 0) raw.permissions = rawPerms;
}

function importMcp(
  value: unknown,
  policy: Policy,
  raw: Record<string, unknown>,
  path: string,
): void {
  if (value === undefined) return;
  if (!isPlainObject(value))
    throw new SourceError([{ path, at: "mcpServers", message: "expected an object" }]);
  const servers: Record<string, McpServer> = {};
  const rawServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(value)) {
    const known =
      isPlainObject(server) &&
      Object.keys(server).every((k) => k === "command" || k === "args" || k === "env") &&
      !JSON.stringify(server).includes("${");
    const parsed = known ? McpServerSchema.safeParse(server) : undefined;
    if (parsed?.success && MCP_SERVER_NAME.test(name)) servers[name] = parsed.data;
    else rawServers[name] = server;
  }
  if (Object.keys(servers).length > 0) policy.mcp = servers;
  if (Object.keys(rawServers).length > 0) raw.mcpServers = rawServers;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceError([{ path, at: "", message: `invalid JSON: ${message}` }]);
  }
  if (!isPlainObject(data))
    throw new SourceError([{ path, at: "", message: "expected a JSON object" }]);
  return data;
}
