import type { Warning } from "../ir/diagnostics.ts";
import type { Layer } from "../ir/parse.ts";
import type { AdapterId, Ir, Scope } from "../ir/schema.ts";

/**
 * How an artifact is written.
 * - `owned`: the whole file belongs to tenore.
 * - `symlink`: `content` is the link target.
 * - `mergeKeys`: `content` is a document (JSON, or TOML with `format: "toml"`)
 *   holding only the listed dotted paths; the writer replaces (or deletes, when
 *   absent from `content`) just those paths in the existing file and leaves
 *   everything else untouched.
 */
export type Strategy = "owned" | "symlink" | { mergeKeys: string[]; format?: DocumentFormat };

export type DocumentFormat = "json" | "toml";

export interface Artifact {
  /** Absolute path. */
  path: string;
  content: string;
  strategy: Strategy;
}

/**
 * Where and what an adapter emits. `emit(ir, ctx)` receives the IR of
 * `ctx.scope` only (a single merged layer); targets that need the full picture,
 * like a single config file, read `ctx.merged`.
 */
export interface EmitContext {
  scope: Scope;
  /** Repo root. */
  root: string;
  home: string;
  /** Raw parsed layer of `scope`, to tell "explicitly set" from "defaulted". */
  layer: Layer;
  /** All scopes merged. */
  merged: Ir;
}

export interface ImportContext {
  scope: Scope;
  root: string;
  home: string;
}

/**
 * What an adapter reads back for one scope. Shaped like a parsed layer rather
 * than `Partial<Ir>` so that "explicitly set" survives (e.g. a `default` that
 * equals the fallback) and `init --import` can write it straight to `.agents/`.
 */
export type ImportResult = Pick<Layer, "instructions" | "memory" | "policy" | "warnings">;

export interface Adapter {
  id: AdapterId;
  detect(root: string): Promise<boolean>;
  emit(ir: Ir, ctx: EmitContext): Promise<Artifact[]>;
  import(root: string, ctx: ImportContext): Promise<ImportResult>;
  /** What this target cannot express exactly for `ctx.scope`. */
  lossy(ir: Ir, ctx: EmitContext): Warning[];
}
