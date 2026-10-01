import type { Warning } from "../../ir/diagnostics.ts";
import {
  type Capability,
  MCP_SERVER_NAME,
  type PermissionLevel,
  type Permissions,
  type Scope,
} from "../../ir/schema.ts";

/**
 * Capability <-> Claude Code permission rule strings.
 *
 * Verified against https://code.claude.com/docs/en/permissions (2026-10):
 * - Bash `*` matches any text including spaces; `x:*` is a legacy spelling of `x *`.
 * - File rules are gitignore-style. `//p` absolute, `~/p` home, `/p` anchored at
 *   the settings source, bare `p` relative to cwd (deny/ask match at any depth).
 * - Write/NotebookEdit are governed by `Edit(...)` rules; `Write(...)` is ignored.
 * - `mcp__server` covers every tool of a server, `mcp__server__tool` one tool.
 *
 * Every decision here has a row in docs/mapping.md.
 */

export type ClaudeRules = Record<PermissionLevel, string[]>;
const LEVELS: readonly PermissionLevel[] = ["allow", "ask", "deny"];

export const NETWORK_TOOLS = ["WebFetch", "WebSearch"] as const;

/** Converts IR permission lists into Claude rule strings for one settings file. */
export function toClaudeRules(
  perms: Pick<Permissions, PermissionLevel>,
  scope: Scope,
): { rules: ClaudeRules; warnings: Warning[] } {
  const rules: ClaudeRules = { allow: [], ask: [], deny: [] };
  const warnings: Warning[] = [];
  for (const list of LEVELS) {
    for (const cap of perms[list]) {
      for (const out of capabilityToRules(cap, list, scope, warnings)) {
        if (!rules[out.list].includes(out.rule)) rules[out.list].push(out.rule);
      }
    }
  }
  return { rules, warnings };
}

function capabilityToRules(
  cap: Capability,
  list: PermissionLevel,
  scope: Scope,
  warnings: Warning[],
): { list: PermissionLevel; rule: string }[] {
  if ("shell" in cap) return [{ list, rule: cap.shell === "*" ? "Bash" : `Bash(${cap.shell})` }];
  if ("mcp" in cap) {
    const [server, tool] = splitMcp(cap.mcp);
    return [{ list, rule: tool === "*" ? `mcp__${server}` : `mcp__${server}__${tool}` }];
  }
  if ("network" in cap) {
    // The level carries the meaning, the list it sits in does not (see merge.ts).
    if (cap.network === "full") return [];
    warnings.push({
      code: "claude-network-shell-bypass",
      message: `network "${cap.network}" only gates WebFetch/WebSearch; shell commands (curl, git) can still reach the network`,
    });
    const target: PermissionLevel = cap.network === "none" ? "deny" : "ask";
    return NETWORK_TOOLS.map((rule) => ({ list: target, rule }));
  }
  const tool = "fs.read" in cap ? "Read" : "Edit";
  const glob = "fs.read" in cap ? cap["fs.read"] : cap["fs.write"];
  const path = toClaudePath(glob, scope);
  if (path === undefined) {
    // Anchored relative paths have no well-defined base in user settings.
    // Allow/ask are dropped (more restrictive); deny is kept unanchored, which
    // in Claude matches at any depth (also more restrictive).
    warnings.push({
      code: "claude-global-anchored-path",
      message: `${tool}(${glob}) in global scope has no project root to anchor to; ${list === "deny" ? "denied at any depth" : "rule dropped"}`,
    });
    return list === "deny" ? [{ list, rule: `${tool}(${glob})` }] : [];
  }
  return [{ list, rule: `${tool}(${path})` }];
}

/**
 * IR path globs follow gitignore: `~/p` home, `/p` absolute, a pattern with an
 * inner `/` is anchored at the scope root, otherwise it matches at any depth.
 * Returns `undefined` when the pattern cannot be anchored in this scope.
 */
export function toClaudePath(glob: string, scope: Scope): string | undefined {
  if (glob.startsWith("~/")) return glob;
  if (glob.startsWith("/")) return `/${glob}`;
  if (!isAnchored(glob)) return glob;
  return scope === "global" ? undefined : `/${glob}`;
}

/** True when a relative glob has a `/` that is not just a trailing one. */
function isAnchored(glob: string): boolean {
  return glob.replace(/\/+$/, "").includes("/");
}

/** Inverse of {@link toClaudePath}; `undefined` for spellings the IR cannot represent exactly. */
export function fromClaudePath(path: string): string | undefined {
  if (path.startsWith("//")) return path.slice(1);
  if (path.startsWith("~/")) return path;
  if (path.startsWith("./")) return undefined;
  if (path.startsWith("/")) {
    const rel = path.slice(1);
    // `/x` with no inner slash is anchored in Claude but would mean "any depth" in the IR.
    return isAnchored(rel) ? rel : undefined;
  }
  // Bare `src/**` is cwd-relative in Claude, not root-anchored like the IR.
  return isAnchored(path) ? undefined : path;
}

/** Parses one Claude rule string; `undefined` means "keep it verbatim as an override". */
export function fromClaudeRule(rule: string): Capability | undefined {
  if (rule === "Bash") return { shell: "*" };
  const call = /^([A-Za-z]+)\((.*)\)$/s.exec(rule);
  if (call) {
    const [, tool, arg = ""] = call;
    if (tool === "Bash" && arg !== "") return { shell: arg.replace(/:\*$/, " *") };
    if (tool === "Read" || tool === "Edit") {
      const glob = fromClaudePath(arg);
      if (glob === undefined || glob === "") return undefined;
      return tool === "Read" ? { "fs.read": glob } : { "fs.write": glob };
    }
    return undefined;
  }
  const mcp = /^mcp__(.+?)(?:__(.+))?$/.exec(rule);
  if (mcp) {
    const [, server = "", tool = "*"] = mcp;
    if (!MCP_SERVER_NAME.test(server) || !/^(?:\*|[A-Za-z0-9_-]+)$/.test(tool)) return undefined;
    return { mcp: `${server}.${tool}` };
  }
  return undefined;
}

function splitMcp(ref: string): [string, string] {
  const dot = ref.indexOf(".");
  return [ref.slice(0, dot), ref.slice(dot + 1)];
}
