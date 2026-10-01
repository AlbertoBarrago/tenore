import { join, relative, sep } from "node:path";
import { z } from "zod";
import type { Strategy } from "../adapters/types.ts";
import { canonicalKey } from "../ir/canonical.ts";
import { fromZod, SourceError } from "../ir/diagnostics.ts";
import { layerDirs } from "../ir/parse.ts";
import { ADAPTER_IDS, type Scope } from "../ir/schema.ts";
import { shortHash } from "./hash.ts";
import { readOptional, writeAtomic } from "./write.ts";

/**
 * One lock per scope, next to that scope's sources:
 * `.agents/.lock` (repo, committed), `.agents/local/.lock` (gitignored with
 * the local layer), `~/.agents/.lock` (global). Keeping them apart means the
 * committed lock never lists personal or gitignored paths.
 */
export const LOCK_FILE = ".lock";

const LockEntrySchema = z.strictObject({
  hash: z.string().regex(/^[0-9a-f]{12}$/),
  adapter: z.enum(ADAPTER_IDS),
  strategy: z.enum(["owned", "symlink", "merge"]),
  mergeKeys: z.array(z.string()).optional(),
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

const LockSchema = z.strictObject({
  version: z.literal(1),
  /** Keyed by path relative to the scope base (repo root, or home for global), POSIX separators. */
  artifacts: z.record(z.string(), LockEntrySchema),
});
export type Lock = z.infer<typeof LockSchema>;

export function emptyLock(): Lock {
  return { version: 1, artifacts: {} };
}

export function lockPath(scope: Scope, root: string, home: string): string {
  return join(layerDirs(root, home)[scope], LOCK_FILE);
}

/** Directory lock keys are relative to. */
export function lockBase(scope: Scope, root: string, home: string): string {
  return scope === "global" ? home : root;
}

export function lockKey(base: string, path: string): string {
  return relative(base, path).split(sep).join("/");
}

export async function readLock(path: string): Promise<Lock> {
  const text = await readOptional(path);
  if (text === undefined) return emptyLock();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceError([{ path, at: "", message: `invalid lock file: ${message}` }]);
  }
  const parsed = LockSchema.safeParse(data);
  if (!parsed.success) throw new SourceError(fromZod(path, parsed.error));
  return parsed.data;
}

/** Sorted keys, stable formatting: the committed lock only changes when an artifact does. */
export function renderLock(lock: Lock): string {
  const artifacts = Object.fromEntries(
    Object.keys(lock.artifacts)
      .sort()
      .map((k) => [k, lock.artifacts[k]]),
  );
  return `${JSON.stringify({ version: 1, artifacts }, null, 2)}\n`;
}

export async function writeLock(path: string, lock: Lock): Promise<void> {
  await writeAtomic(path, renderLock(lock));
}

export function entryStrategy(strategy: Strategy): Pick<LockEntry, "strategy" | "mergeKeys"> {
  if (typeof strategy === "string") return { strategy };
  return { strategy: "merge", mergeKeys: [...strategy.mergeKeys] };
}

/**
 * Hash of the part of a file tenore owns: the whole text for owned files and
 * symlinks, only the owned JSON paths for merged files, so edits to other keys
 * of a shared settings file are never reported as drift.
 */
export function ownedHash(entry: Pick<LockEntry, "strategy" | "mergeKeys">, text: string): string {
  if (entry.strategy !== "merge") return shortHash(text);
  return shortHash(canonicalKey(extractKeys(JSON.parse(text), entry.mergeKeys ?? [])));
}

export function extractKeys(data: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    let cur: unknown = data;
    for (const seg of key.split(".")) {
      cur =
        typeof cur === "object" && cur !== null && !Array.isArray(cur)
          ? (cur as Record<string, unknown>)[seg]
          : undefined;
    }
    if (cur !== undefined) out[key] = cur;
  }
  return out;
}
