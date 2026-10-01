import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import type { ImportResult } from "../adapters/types.ts";
import { INSTRUCTIONS_FILE, MEMORY_DIR, POLICY_FILE } from "./parse.ts";
import { type Policy, PolicySchema } from "./schema.ts";

/**
 * Renders an imported layer as `.agents/` source files (path -> content),
 * the inverse of `parseLayer`. Pure: writing is the caller's job.
 */
export function layerFiles(dir: string, layer: ImportResult): Record<string, string> {
  const files: Record<string, string> = {};

  if (layer.instructions.length > 0) {
    const target = join(dir, INSTRUCTIONS_FILE);
    files[target] = layer.instructions
      .map((block) => rebaseImports(block.body, dirname(block.source), dir))
      .join("\n");
  }
  for (const m of layer.memory) files[join(dir, MEMORY_DIR, `${m.topic}.md`)] = m.body;

  const policy = PolicySchema.parse(layer.policy);
  if (Object.keys(policy).length > 0) files[join(dir, POLICY_FILE)] = renderPolicy(policy);
  return files;
}

/** Lets YAML-aware editors validate the frontmatter against the published schema. */
export const SCHEMA_COMMENT =
  "# yaml-language-server: $schema=https://raw.githubusercontent.com/AlbertoBarrago/tenore/main/schema/policy.schema.json";

export function renderPolicy(policy: Policy): string {
  // gray-matter appends the (empty) body after a blank line; keep one trailing newline.
  const rendered = matter.stringify("", policy).trimEnd();
  return `---\n${SCHEMA_COMMENT}\n${rendered.slice("---\n".length)}\n`;
}

/**
 * Claude resolves `@path` imports relative to the importing file. When a
 * hand-written CLAUDE.md moves into `.agents/`, relative imports would break,
 * so each one that points to an existing file is rewritten relative to the
 * new location. Code spans and fences are skipped, as Claude skips them; an
 * `@word` that is not an existing file (a mention, an email) is left alone.
 */
export function rebaseImports(body: string, fromDir: string, toDir: string): string {
  if (fromDir === toDir) return body;
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 === 1 ? part : rebaseText(part, fromDir, toDir)))
        .join("");
    })
    .join("\n");
}

function rebaseText(text: string, fromDir: string, toDir: string): string {
  return text.replace(/(^|\s)@([^\s`]+)/g, (match, pre: string, ref: string) => {
    if (ref.startsWith("~/") || isAbsolute(ref)) return match;
    const target = resolve(fromDir, ref);
    if (!existsSync(target)) return match;
    const rebased = relative(toDir, target).split(sep).join("/");
    return `${pre}@${rebased}`;
  });
}
