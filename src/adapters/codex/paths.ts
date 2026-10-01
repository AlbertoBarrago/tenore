import { join } from "node:path";
import type { Scope } from "../../ir/schema.ts";

/**
 * Codex native locations per scope. Codex has no local config layer: the local
 * scope only contributes instructions, through `AGENTS.override.md`.
 * `CODEX_HOME` is not honored yet; the global scope assumes `~/.codex`.
 */
export function codexPaths(scope: Scope, root: string, home: string) {
  if (scope === "global") {
    const dir = join(home, ".codex");
    return {
      instructions: join(dir, "AGENTS.md"),
      config: join(dir, "config.toml"),
      rules: join(dir, "rules", "tenore.rules"),
    };
  }
  if (scope === "repo") {
    return {
      instructions: join(root, "AGENTS.md"),
      config: join(root, ".codex", "config.toml"),
      rules: join(root, ".codex", "rules", "tenore.rules"),
    };
  }
  return { instructions: join(root, "AGENTS.override.md"), config: undefined, rules: undefined };
}
