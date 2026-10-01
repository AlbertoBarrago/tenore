import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isPlainObject } from "../../ir/canonical.ts";
import { SourceError, type Warning } from "../../ir/diagnostics.ts";
import {
  INSTRUCTIONS_FILE,
  isNotFound,
  layerDirs,
  MEMORY_DIR,
  normalizeText,
  readText,
} from "../../ir/parse.ts";
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
import { claudePaths } from "./paths.ts";
import { fromClaudeRule, NETWORK_TOOLS } from "./permissions.ts";

/**
 * Reads Claude Code's native files for one scope back into a layer.
 *
 * Anything the IR cannot represent exactly is preserved verbatim under
 * `overrides.claude` (rules, `defaultMode`, MCP servers) so that
 * import -> sync -> import is lossless.
 */
export async function importClaude(root: string, ctx: ImportContext): Promise<ImportResult> {
  const paths = claudePaths(ctx.scope, root, ctx.home);
  const warnings: Warning[] = [];
  const { instructions, memory } = await importMemoryFile(paths.memory, root, ctx, warnings);

  const policy: Policy = {};
  const claudeOverrides: Record<string, unknown> = {};

  const settings = await readJson(paths.settings);
  if (settings !== undefined) {
    const imported = importPermissions(settings.permissions, paths.settings);
    if (imported.permissions) policy.permissions = imported.permissions;
    if (imported.raw) claudeOverrides.permissions = imported.raw;
  }

  if (paths.mcp !== undefined) {
    const mcpJson = await readJson(paths.mcp);
    if (mcpJson !== undefined) {
      const imported = importMcp(mcpJson.mcpServers, paths.mcp, warnings);
      if (Object.keys(imported.servers).length > 0) policy.mcp = imported.servers;
      if (Object.keys(imported.raw).length > 0) claudeOverrides.mcpServers = imported.raw;
    }
  }

  if (Object.keys(claudeOverrides).length > 0) policy.overrides = { claude: claudeOverrides };
  return { instructions, memory, policy, warnings };
}

/**
 * A generated file (with header) is a list of `@` imports pointing into
 * `.agents/`; they are resolved back to the source blocks. A hand-written file
 * becomes one verbatim instruction block: its text is never rewritten.
 */
async function importMemoryFile(
  path: string,
  root: string,
  ctx: ImportContext,
  warnings: Warning[],
): Promise<{ instructions: InstructionBlock[]; memory: MemoryBlock[] }> {
  const text = await readText(path);
  if (text === undefined) return { instructions: [], memory: [] };
  const generated = parseHeader(text);
  if (!generated)
    return { instructions: [{ source: path, scope: ctx.scope, body: text }], memory: [] };

  const layerDir = layerDirs(root, ctx.home)[ctx.scope];
  const instructions: InstructionBlock[] = [];
  const memory: MemoryBlock[] = [];
  const inlined: string[] = [];

  for (const line of generated.body.split("\n")) {
    if (!line.startsWith("@")) {
      inlined.push(line);
      continue;
    }
    const target = resolveImport(line.slice(1), path, ctx.home);
    const body = await readText(target);
    if (body === undefined) {
      warnings.push({
        code: "claude-import-missing",
        message: `${line} points to a missing file`,
        path,
      });
      continue;
    }
    if (target === join(layerDir, INSTRUCTIONS_FILE)) {
      instructions.push({ source: target, scope: ctx.scope, body });
    } else if (dirname(target) === join(layerDir, MEMORY_DIR) && target.endsWith(".md")) {
      memory.push({ topic: basename(target, ".md"), scope: ctx.scope, body });
    } else {
      warnings.push({
        code: "claude-import-foreign",
        message: `${line} is outside ${layerDir}; imported as an instruction block`,
        path,
      });
      instructions.push({ source: target, scope: ctx.scope, body });
    }
  }

  // Content inlined by emit (paths with whitespace) cannot be traced back to
  // its source file; keep it as an instruction block of the generated file.
  const rest = inlined.join("\n").trim();
  if (rest !== "") instructions.push({ source: path, scope: ctx.scope, body: `${rest}\n` });
  return { instructions, memory };
}

/** Claude resolves `@` imports relative to the importing file; `~/` is the home directory. */
function resolveImport(ref: string, importer: string, home: string): string {
  if (ref.startsWith("~/")) return join(home, ref.slice(2));
  return isAbsolute(ref) ? ref : resolve(dirname(importer), ref);
}

type RawRules = Partial<Record<PermissionLevel, string[]>> & { defaultMode?: string };

function importPermissions(
  value: unknown,
  path: string,
): { permissions?: NonNullable<Policy["permissions"]>; raw?: RawRules } {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new SourceError([{ path, at: "permissions", message: "expected an object" }]);
  }

  const permissions: NonNullable<Policy["permissions"]> = {};
  const raw: RawRules = {};

  for (const list of ["allow", "ask", "deny"] as const) {
    const rules = value[list];
    if (rules === undefined) continue;
    if (!Array.isArray(rules) || !rules.every((r) => typeof r === "string")) {
      throw new SourceError([
        { path, at: `permissions.${list}`, message: "expected an array of strings" },
      ]);
    }
    const { caps, unmapped } = importRules(rules, list);
    if (caps.length > 0) permissions[list] = caps;
    if (unmapped.length > 0) raw[list] = unmapped;
  }

  const mode = value.defaultMode;
  if (mode === "default") permissions.default = "ask";
  else if (mode === "dontAsk") permissions.default = "deny";
  else if (typeof mode === "string") raw.defaultMode = mode;

  return {
    ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
    ...(Object.keys(raw).length > 0 ? { raw } : {}),
  };
}

/**
 * Maps rule strings to capabilities. `WebFetch` + `WebSearch` together in deny
 * (or ask) are exactly what `network: none` (or `restricted`) emits; alone, or
 * in allow, they stay raw.
 */
function importRules(
  rules: string[],
  list: PermissionLevel,
): { caps: Capability[]; unmapped: string[] } {
  const caps: Capability[] = [];
  const unmapped: string[] = [];
  const unique = [...new Set(rules)];
  const network = list !== "allow" && NETWORK_TOOLS.every((t) => unique.includes(t));
  let networkAdded = false;

  for (const rule of unique) {
    if (network && (NETWORK_TOOLS as readonly string[]).includes(rule)) {
      if (!networkAdded) caps.push({ network: list === "deny" ? "none" : "restricted" });
      networkAdded = true;
      continue;
    }
    const cap = fromClaudeRule(rule);
    if (cap) caps.push(cap);
    else unmapped.push(rule);
  }
  return { caps, unmapped };
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Values whose key looks like a credential but are literals rather than `${VAR}` references. */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|KEY|AUTH/i;

function importMcp(
  value: unknown,
  path: string,
  warnings: Warning[],
): { servers: Record<string, McpServer>; raw: Record<string, unknown> } {
  const servers: Record<string, McpServer> = {};
  const raw: Record<string, unknown> = {};
  if (value === undefined) return { servers, raw };
  if (!isPlainObject(value)) {
    throw new SourceError([{ path, at: "mcpServers", message: "expected an object" }]);
  }

  for (const [name, server] of Object.entries(value)) {
    const converted = toIrServer(server);
    if (converted && MCP_SERVER_NAME.test(name)) servers[name] = converted;
    else raw[name] = server;

    if (isPlainObject(server) && isPlainObject(server.env)) {
      for (const [key, v] of Object.entries(server.env)) {
        if (SECRET_KEY.test(key) && typeof v === "string" && v !== "" && !v.includes("${")) {
          warnings.push({
            code: "mcp-literal-secret",
            message: `${name}.env.${key} looks like a literal secret; use \${env:${key}} in .agents/policy.md`,
            path,
          });
        }
      }
    }
  }
  return { servers, raw };
}

/**
 * Converts a stdio server whose placeholders are all plain `${VAR}`. Remote
 * servers and `${VAR:-default}` have no IR form and are kept raw.
 */
function toIrServer(server: unknown): McpServer | undefined {
  if (!isPlainObject(server)) return undefined;
  const { type, ...rest } = server;
  if (type !== undefined && type !== "stdio") return undefined;

  const toIr = (v: unknown) => (typeof v === "string" ? v.replace(ENV_REF, "${env:$1}") : v);
  const candidate = {
    ...rest,
    command: toIr(rest.command),
    ...(Array.isArray(rest.args) ? { args: rest.args.map(toIr) } : {}),
    ...(isPlainObject(rest.env)
      ? { env: Object.fromEntries(Object.entries(rest.env).map(([k, v]) => [k, toIr(v)])) }
      : {}),
  };
  const parsed = McpServerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = normalizeText(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
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
