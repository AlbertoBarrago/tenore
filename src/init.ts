import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, ImportResult } from "./adapters/types.ts";
import { canonicalKey, dedupe, isPlainObject } from "./ir/canonical.ts";
import {
  INSTRUCTIONS_FILE,
  type Layer,
  layerDirs,
  MEMORY_DIR,
  POLICY_FILE,
  parseLayers,
} from "./ir/parse.ts";
import type { Capability, McpServer, PermissionLevel, Policy, Scope } from "./ir/schema.ts";
import { layerFiles, renderPolicy } from "./ir/serialize.ts";
import {
  entryStrategy,
  lockBase,
  lockKey,
  lockPath,
  ownedHash,
  readLock,
  writeLock,
} from "./sync/lock.ts";
import { planSync } from "./sync/plan.ts";
import { readOptional, writeAtomic } from "./sync/write.ts";

export interface InitResult {
  written: string[];
  /** Existing files that would change; nothing is written for their scope without `force`. */
  blocked: string[];
  /** Native files whose current content was recorded in the lock so the next sync may replace them. */
  adopted: string[];
  notes: string[];
  warnings: ImportResult["warnings"];
}

const AGENTS_TEMPLATE = `# Agent instructions

Shared instructions for every coding agent working in this repository.
Edit this file, then run \`tenore sync\`.
`;

const GITIGNORE_LINES = [
  ".agents/local/",
  "CLAUDE.local.md",
  "AGENTS.override.md",
  ".agents/rules/tenore-local.md",
];

/** Creates an empty `.agents/` layout. Existing files are never overwritten. */
export async function scaffold(
  root: string,
  home: string,
  scope: "global" | "repo",
): Promise<InitResult> {
  const dir = layerDirs(root, home)[scope];
  const result: InitResult = { written: [], blocked: [], adopted: [], notes: [], warnings: [] };
  const files: Record<string, string> = {
    [join(dir, INSTRUCTIONS_FILE)]: AGENTS_TEMPLATE,
    [join(dir, POLICY_FILE)]: renderPolicy({ permissions: { default: "ask" } }),
    [join(dir, MEMORY_DIR, ".gitkeep")]: "",
  };
  for (const [path, content] of Object.entries(files)) {
    if (existsSync(path)) continue;
    await writeAtomic(path, content);
    result.written.push(path);
  }
  if (scope === "repo") {
    const added = await ensureGitignore(root);
    if (added.length > 0) result.notes.push(`added to .gitignore: ${added.join(", ")}`);
  }
  return result;
}

/**
 * Appends the local-only paths to `.gitignore`, only in a VCS checkout or
 * where a `.gitignore` already exists.
 */
async function ensureGitignore(root: string): Promise<string[]> {
  const path = join(root, ".gitignore");
  const current = await readOptional(path);
  if (current === undefined && !existsSync(join(root, ".git")) && !existsSync(join(root, ".jj")))
    return [];
  const lines = new Set((current ?? "").split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !lines.has(l) && !lines.has(`/${l}`));
  if (missing.length === 0) return [];
  const prefix =
    current === undefined || current === "" || current.endsWith("\n")
      ? (current ?? "")
      : `${current}\n`;
  await writeAtomic(path, `${prefix}${missing.join("\n")}\n`);
  return missing;
}

/**
 * `init --import <adapter>`: reads the native files of each scope into
 * `.agents/`, then records the native files in the lock so the next `sync`
 * replaces them with generated ones instead of reporting a conflict.
 *
 * This is also the recovery path for drift: a hand edit to a generated file is
 * pulled back into the sources.
 */
export async function importInto(
  adapter: Adapter,
  root: string,
  home: string,
  scopes: readonly Scope[],
  force: boolean,
): Promise<InitResult> {
  const result: InitResult = { written: [], blocked: [], adopted: [], notes: [], warnings: [] };
  const existing = await parseLayers(root, home);
  const dirs = layerDirs(root, home);
  const importedScopes: Scope[] = [];

  for (const scope of scopes) {
    const imported = await adapter.import(root, { scope, root, home });
    result.warnings.push(...imported.warnings);
    if (isEmpty(imported)) continue;

    const layer = existing.find((l) => l.scope === scope);
    const files = layerFiles(dirs[scope], {
      ...imported,
      policy: mergePolicy(adapter, layer, imported.policy, scope),
    });
    const changed: [string, string][] = [];
    for (const [path, content] of Object.entries(files)) {
      if ((await readOptional(path)) !== content) changed.push([path, content]);
    }
    const blocked = [];
    for (const [path] of changed) if (existsSync(path)) blocked.push(path);
    if (blocked.length > 0 && !force) {
      result.blocked.push(...blocked);
      continue;
    }
    for (const [path, content] of changed) {
      await writeAtomic(path, content);
      result.written.push(path);
    }
    importedScopes.push(scope);
  }

  result.adopted = await adoptNative(adapter, root, home, importedScopes);
  return result;
}

const LEVELS: readonly PermissionLevel[] = ["allow", "ask", "deny"];

/**
 * The import is authoritative only for what the adapter expresses exactly.
 * Everything else in the existing layer is kept: capabilities the target drops
 * or rewrites (fs rules on Codex, a glob broadened to a prefix), MCP servers it
 * does not emit in this scope, and other adapters' overrides. The rewritten
 * echo of a kept capability is removed from the import so it is not duplicated.
 */
export function mergePolicy(
  adapter: Adapter,
  layer: Layer | undefined,
  imported: Policy,
  scope: Scope,
): Policy {
  const current = layer?.policy ?? {};
  const fromImport: Record<PermissionLevel, Capability[]> = {
    allow: [...(imported.permissions?.allow ?? [])],
    ask: [...(imported.permissions?.ask ?? [])],
    deny: [...(imported.permissions?.deny ?? [])],
  };
  const kept: Record<PermissionLevel, Capability[]> = { allow: [], ask: [], deny: [] };

  for (const list of LEVELS) {
    for (const cap of current.permissions?.[list] ?? []) {
      const echo = adapter.expresses.capability(cap, list, scope);
      if (echo && echo.list === list && canonicalKey(echo.cap) === canonicalKey(cap)) continue;
      kept[list].push(cap);
      if (echo) {
        const target = fromImport[echo.list];
        const i = target.findIndex((c) => canonicalKey(c) === canonicalKey(echo.cap));
        if (i >= 0) target.splice(i, 1);
      }
    }
  }

  const out: Policy = {};
  const permissions: NonNullable<Policy["permissions"]> = {};
  const def = imported.permissions?.default ?? current.permissions?.default;
  if (def !== undefined) permissions.default = def;
  for (const list of LEVELS) {
    const caps = dedupe([...kept[list], ...fromImport[list]]);
    if (caps.length > 0) permissions[list] = caps;
  }
  if (Object.keys(permissions).length > 0) out.permissions = permissions;

  const mcp: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(current.mcp ?? {})) {
    if (!adapter.expresses.server(name, server, scope)) mcp[name] = server;
  }
  Object.assign(mcp, imported.mcp);
  if (Object.keys(mcp).length > 0) out.mcp = mcp;

  const others = Object.fromEntries(
    Object.entries(current.overrides ?? {}).filter(([id]) => id !== adapter.id),
  );
  const own = imported.overrides?.[adapter.id];
  const overrides = { ...others, ...(own ? { [adapter.id]: own } : {}) };
  if (Object.keys(overrides).length > 0) out.overrides = overrides;
  return out;
}

/**
 * Records the current owned hash of each native file that sync would refuse
 * to touch (conflict or drift), now that its content lives in `.agents/`.
 */
async function adoptNative(
  adapter: Adapter,
  root: string,
  home: string,
  scopes: Scope[],
): Promise<string[]> {
  if (scopes.length === 0) return [];
  const plan = await planSync([adapter], await parseLayers(root, home), scopes, root, home);
  const adopted: string[] = [];
  for (const scope of scopes) {
    const path = lockPath(scope, root, home);
    const lock = await readLock(path);
    const base = lockBase(scope, root, home);
    let dirty = false;
    for (const action of plan.actions) {
      if (action.scope !== scope || !action.artifact || action.before === undefined) continue;
      if (action.kind !== "conflict" && action.kind !== "drift") continue;
      const strategy = entryStrategy(action.artifact.strategy);
      let hash: string;
      try {
        hash = ownedHash(strategy, action.before);
      } catch {
        // Invalid JSON stays a conflict for the user to fix by hand; it is reported by sync.
        continue;
      }
      lock.artifacts[lockKey(base, action.path)] = { hash, adapter: adapter.id, ...strategy };
      adopted.push(action.path);
      dirty = true;
    }
    if (dirty) await writeLock(path, lock);
  }
  return adopted;
}

function isEmpty(r: ImportResult): boolean {
  const policy = r.policy;
  return (
    r.instructions.length === 0 &&
    r.memory.length === 0 &&
    !policy.permissions &&
    !policy.mcp &&
    !(isPlainObject(policy.overrides) && Object.keys(policy.overrides).length > 0)
  );
}
