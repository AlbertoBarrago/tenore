import { join } from "node:path";
import type { Scope } from "../../ir/schema.ts";

/** Native file locations per scope. */
export function claudePaths(scope: Scope, root: string, home: string) {
  if (scope === "global") {
    const dir = join(home, ".claude");
    return { memory: join(dir, "CLAUDE.md"), settings: join(dir, "settings.json"), mcp: undefined };
  }
  if (scope === "repo") {
    return {
      memory: join(root, "CLAUDE.md"),
      settings: join(root, ".claude", "settings.json"),
      mcp: join(root, ".mcp.json"),
    };
  }
  return {
    memory: join(root, "CLAUDE.local.md"),
    settings: join(root, ".claude", "settings.local.json"),
    mcp: undefined,
  };
}
