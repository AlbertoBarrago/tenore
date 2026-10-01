import type { AdapterId } from "../ir/schema.ts";
import { antigravity } from "./antigravity.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { gemini } from "./gemini.ts";
import type { Adapter } from "./types.ts";

export const adapters: Record<AdapterId, Adapter> = { claude, codex, gemini, antigravity };

/** Adapters with a working emit; stubs are excluded from default sync targets. */
export const IMPLEMENTED: readonly AdapterId[] = ["claude", "codex"];

export type {
  Adapter,
  Artifact,
  EmitContext,
  ImportContext,
  ImportResult,
  Strategy,
} from "./types.ts";
