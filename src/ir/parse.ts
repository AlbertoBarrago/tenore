import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { fromZod, type Issue, SourceError, type Warning } from "./diagnostics.ts";
import {
  type InstructionBlock,
  type MemoryBlock,
  type Policy,
  PolicySchema,
  SCOPES,
  type Scope,
} from "./schema.ts";

/** Everything read from one `.agents/` directory, before merging. */
export interface Layer {
  scope: Scope;
  dir: string;
  /** False when the directory does not exist; the layer is then empty. */
  exists: boolean;
  instructions: InstructionBlock[];
  memory: MemoryBlock[];
  policy: Policy;
  warnings: Warning[];
}

export const INSTRUCTIONS_FILE = "AGENTS.md";
export const POLICY_FILE = "policy.md";
export const MEMORY_DIR = "memory";
export const LOCAL_DIR = "local";

/** Source directory of each scope. The local layer is nested inside the repo layer. */
export function layerDirs(root: string, home: string): Record<Scope, string> {
  const repo = join(root, ".agents");
  return { global: join(home, ".agents"), repo, local: join(repo, LOCAL_DIR) };
}

/**
 * Parses all three layers in scope order. Validation problems from every layer
 * are collected and thrown together so `check` can report them in one pass.
 */
export async function parseLayers(root: string, home: string): Promise<Layer[]> {
  const dirs = layerDirs(root, home);
  const layers: Layer[] = [];
  const issues: Issue[] = [];
  const globalReal = await realpathOrSelf(dirs.global);

  for (const scope of SCOPES) {
    // Running from $HOME makes the repo layer the same directory as the global
    // one; reading it twice would duplicate every instruction and rule.
    if (scope === "repo" && (await realpathOrSelf(dirs.repo)) === globalReal) {
      const layer = emptyLayer(scope, dirs.repo, false);
      layer.warnings.push({
        code: "repo-is-global",
        message: "repo .agents/ is the global ~/.agents/, reading it once as global",
        path: dirs.repo,
      });
      layers.push(layer);
      continue;
    }
    try {
      layers.push(await parseLayer(dirs[scope], scope));
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      issues.push(...error.issues);
    }
  }
  if (issues.length > 0) throw new SourceError(issues);
  return layers;
}

/** Parses a single `.agents/` directory. A missing directory yields an empty layer. */
export async function parseLayer(dir: string, scope: Scope): Promise<Layer> {
  if (!(await isDirectory(dir))) return emptyLayer(scope, dir, false);
  const layer = emptyLayer(scope, dir, true);

  const instructionsPath = join(dir, INSTRUCTIONS_FILE);
  const instructions = await readText(instructionsPath);
  if (instructions !== undefined) {
    layer.instructions.push({ source: instructionsPath, scope, body: instructions });
  }

  const policyPath = join(dir, POLICY_FILE);
  const policyText = await readText(policyPath);
  if (policyText !== undefined) {
    const parsed = parsePolicy(policyPath, policyText);
    layer.policy = parsed.policy;
    layer.warnings.push(...parsed.warnings);
  }

  layer.memory = await readMemory(join(dir, MEMORY_DIR), scope);
  return layer;
}

/**
 * Parses `policy.md`. Only YAML frontmatter is accepted: gray-matter would
 * otherwise evaluate `---js` / `---coffee` frontmatter as code, which is not
 * acceptable for a file that may come from any cloned repo.
 */
export function parsePolicy(path: string, text: string): { policy: Policy; warnings: Warning[] } {
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (firstLine.startsWith("---") && firstLine.trimEnd() !== "---") {
    throw new SourceError([
      { path, at: "", message: `only YAML frontmatter is supported, found "${firstLine}"` },
    ]);
  }

  let file: matter.GrayMatterFile<string>;
  try {
    // Passing options also disables gray-matter's content-keyed cache, which
    // returns shared mutable objects across calls.
    file = matter(text, { language: "yaml", engines: REFUSED_ENGINES });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SourceError([{ path, at: "", message: `invalid frontmatter: ${message}` }]);
  }

  const result = PolicySchema.safeParse(file.data ?? {});
  if (!result.success) throw new SourceError(fromZod(path, result.error));

  const warnings: Warning[] = [];
  if (file.content.trim() !== "") {
    warnings.push({
      code: "policy-body-ignored",
      message: "policy.md body is ignored, put prose in AGENTS.md",
      path,
    });
  }
  return { policy: result.data, warnings };
}

const refuse = (): never => {
  throw new Error("only YAML frontmatter is supported");
};
const REFUSED_ENGINES = {
  js: refuse,
  javascript: refuse,
  coffee: refuse,
  coffeescript: refuse,
  cson: refuse,
};

/** Memory files sorted by name (code point order, locale independent); topic = basename. */
async function readMemory(dir: string, scope: Scope): Promise<MemoryBlock[]> {
  if (!(await isDirectory(dir))) return [];
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const memory: MemoryBlock[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!(await isFile(path))) continue;
    const body = await readText(path);
    if (body !== undefined) memory.push({ topic: basename(name, ".md"), scope, body });
  }
  return memory;
}

function emptyLayer(scope: Scope, dir: string, exists: boolean): Layer {
  return { scope, dir, exists, instructions: [], memory: [], policy: {}, warnings: [] };
}

/** Reads UTF-8 text with BOM stripped and CRLF normalized; `undefined` when the file is missing. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return normalizeText(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export function normalizeText(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) return path;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
