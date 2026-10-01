import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { Artifact, DocumentFormat } from "../adapters/types.ts";
import { canonicalKey, isPlainObject } from "../ir/canonical.ts";
import { SourceError } from "../ir/diagnostics.ts";
import { isNotFound } from "../ir/parse.ts";

/**
 * Final on-disk content of an artifact, given what is there now.
 * For `mergeKeys` the existing file is preserved except for the owned paths;
 * when nothing owned changes, the existing bytes are returned untouched so
 * user formatting does not churn.
 */
export async function renderArtifact(artifact: Artifact): Promise<string> {
  if (typeof artifact.strategy === "string") return artifact.content;
  const format = artifact.strategy.format ?? "json";
  const existingText = await readOptional(artifact.path);
  const existing = existingText === undefined ? {} : parseFile(format, artifact.path, existingText);
  const owned = parseFile(format, artifact.path, artifact.content);
  const merged = applyMergeKeys(existing, owned, artifact.strategy.mergeKeys);
  if (existingText !== undefined && canonicalKey(merged) === canonicalKey(existing))
    return existingText;
  return serializeDocument(format, merged);
}

/**
 * Sets every dotted `key` from `owned` into a copy of `existing`, or deletes it
 * when `owned` lacks it. Parents emptied by a deletion are removed too.
 * Untouched keys keep their position; new keys are appended.
 */
export function applyMergeKeys(
  existing: Record<string, unknown>,
  owned: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out = structuredClone(existing);
  for (const key of keys) {
    const path = key.split(".");
    const value = getPath(owned, path);
    if (value === undefined) deletePath(out, path);
    else setPath(out, path, value);
  }
  return out;
}

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (const seg of path.slice(0, -1)) {
    const next = cur[seg];
    if (!isPlainObject(next)) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = value;
}

function deletePath(obj: Record<string, unknown>, path: string[]): void {
  const [head, ...rest] = path;
  if (head === undefined || !(head in obj)) return;
  if (rest.length === 0) {
    delete obj[head];
    return;
  }
  const child = obj[head];
  if (!isPlainObject(child)) return;
  deletePath(child, rest);
  if (Object.keys(child).length === 0) delete obj[head];
}

/** Writes an artifact atomically, see {@link writeAtomic}. */
export async function writeArtifact(artifact: Artifact): Promise<void> {
  if (artifact.strategy === "symlink") return replaceSymlink(artifact.path, artifact.content);
  await writeAtomic(artifact.path, await renderArtifact(artifact));
}

/**
 * Temp file in the same directory (same filesystem, so rename is atomic) then
 * rename over the target. Preserves the mode of an existing file. The temp
 * name matches the `*.tmp-*` gitignore pattern in case a crash leaves it behind.
 */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  try {
    await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
    const mode = await existingMode(path);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function replaceSymlink(path: string, target: string): Promise<void> {
  try {
    if ((await readlink(path)) === target) return;
  } catch (error) {
    if (
      !isNotFound(error) &&
      !(error instanceof Error && "code" in error && error.code === "EINVAL")
    ) {
      throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  try {
    await symlink(target, tmp);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function tmpName(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Parses a JSON object or a TOML document; throws on syntax errors. */
export function parseDocument(format: DocumentFormat, text: string): Record<string, unknown> {
  const data: unknown = format === "toml" ? parseToml(text) : JSON.parse(text);
  if (!isPlainObject(data)) throw new Error("expected a JSON object");
  return data;
}

/**
 * TOML comments in a merged file do not survive a rewrite; the file is only
 * rewritten when an owned key actually changes (see renderArtifact).
 */
export function serializeDocument(format: DocumentFormat, data: Record<string, unknown>): string {
  if (format === "json") return `${JSON.stringify(data, null, 2)}\n`;
  const text = stringifyToml(data);
  return text === "" ? "" : `${text.replace(/\n+$/, "")}\n`;
}

function parseFile(format: DocumentFormat, path: string, text: string): Record<string, unknown> {
  try {
    return parseDocument(format, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceError([
      { path, at: "", message: `invalid ${format.toUpperCase()}: ${message}` },
    ]);
  }
}
