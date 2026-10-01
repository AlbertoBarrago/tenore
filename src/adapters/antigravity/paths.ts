import { join } from "node:path";
import type { Scope } from "../../ir/schema.ts";

/**
 * Antigravity native locations (CLI 1.2, docs 2026-10). Repo instructions need
 * no artifact: Antigravity reads `.agents/AGENTS.md` natively. Permissions only
 * exist in the user settings file; there is no project or local layer.
 */
export function antigravityPaths(scope: Scope, root: string, home: string) {
  if (scope === "global") {
    return {
      rules: join(home, ".gemini", "config", "rules", "tenore.md"),
      settings: join(home, ".gemini", "antigravity-cli", "settings.json"),
      mcp: join(home, ".gemini", "config", "mcp_config.json"),
      handWritten: [join(home, ".gemini", "AGENTS.md"), join(home, ".gemini", "GEMINI.md")],
    };
  }
  if (scope === "repo") {
    return {
      rules: join(root, ".agents", "rules", "tenore-memory.md"),
      settings: undefined,
      mcp: join(root, ".agents", "mcp_config.json"),
      handWritten: [join(root, "GEMINI.md")],
    };
  }
  return {
    rules: join(root, ".agents", "rules", "tenore-local.md"),
    settings: undefined,
    mcp: undefined,
    handWritten: [],
  };
}
