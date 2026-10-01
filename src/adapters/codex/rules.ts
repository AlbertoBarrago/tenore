import type { Warning } from "../../ir/diagnostics.ts";
import type { Capability, PermissionLevel, Permissions } from "../../ir/schema.ts";

/**
 * Shell capabilities -> Codex `prefix_rule()` (Starlark `.rules` files).
 *
 * Codex matches an exact argv prefix, not a glob. A glob is cut at its first
 * token containing a wildcard: the remaining prefix matches *more* commands,
 * which is the safe direction for `prompt`/`forbidden`. `allow` is never
 * emitted: in Codex it means "run outside the sandbox without asking", wider
 * than the IR's "do not ask".
 */
export type Decision = "prompt" | "forbidden";

export interface PrefixRule {
  pattern: string[];
  decision: Decision;
}

const WILDCARD = /[*?[]/;

export function toPrefixRules(perms: Pick<Permissions, PermissionLevel>): {
  rules: PrefixRule[];
  warnings: Warning[];
} {
  const rules: PrefixRule[] = [];
  const warnings: Warning[] = [];
  const seen = new Set<string>();

  for (const list of ["deny", "ask", "allow"] as const) {
    for (const cap of perms[list] as Capability[]) {
      if (!("shell" in cap)) continue;
      if (list === "allow") {
        warnings.push({
          code: "codex-shell-allow-sandboxed",
          message: `allow shell "${cap.shell}" is not emitted: Codex runs it inside the sandbox (an allow rule would bypass it)`,
        });
        continue;
      }
      const decision: Decision = list === "deny" ? "forbidden" : "prompt";
      const { pattern, exact } = globToPrefix(cap.shell);
      if (pattern.length === 0) {
        warnings.push({
          code: "codex-shell-unexpressible",
          message: `${list} shell "${cap.shell}" starts with a wildcard and is ${list === "deny" ? "NOT ENFORCED" : "not emitted"} for Codex`,
        });
        continue;
      }
      if (!exact) {
        warnings.push({
          code: "codex-shell-broadened",
          message: `${list} shell "${cap.shell}" is broadened to the prefix "${pattern.join(" ")}" for Codex`,
        });
      }
      const key = `${decision}:${JSON.stringify(pattern)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ pattern, decision });
    }
  }
  return { rules, warnings };
}

/**
 * `git push` and `git push *` are exact prefixes (Codex also matches the bare
 * command, which only widens a prompt/forbid). `npm run test*` or `git * --force`
 * are cut before the wildcard token and flagged as broadened.
 */
export function globToPrefix(glob: string): { pattern: string[]; exact: boolean } {
  const tokens = glob
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "");
  const idx = tokens.findIndex((t) => WILDCARD.test(t));
  if (idx === -1) return { pattern: tokens, exact: true };
  const exact = idx > 0 && idx === tokens.length - 1 && tokens[idx] === "*";
  return { pattern: tokens.slice(0, idx), exact };
}

export function renderRules(rules: PrefixRule[]): string {
  return rules
    .map((r) => `prefix_rule(pattern = ${starlarkList(r.pattern)}, decision = "${r.decision}")\n`)
    .join("");
}

function starlarkList(items: string[]): string {
  // JSON string escaping (\" \\ \n \uXXXX) is valid Starlark string syntax.
  return `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
}

/** Only the exact form produced by {@link renderRules}; anything else is kept verbatim by the importer. */
const RULE_LINE = /^prefix_rule\(pattern = (\[.*\]), decision = "(prompt|forbidden)"\)$/;

export function parseRules(text: string): { rules: PrefixRule[]; rest: string } {
  const rules: PrefixRule[] = [];
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    const m = RULE_LINE.exec(line);
    const pattern = m?.[1] ? parsePattern(m[1]) : undefined;
    if (m && pattern) rules.push({ pattern, decision: m[2] as Decision });
    else rest.push(line);
  }
  const joined = rest.join("\n").trim();
  return { rules, rest: joined === "" ? "" : `${joined}\n` };
}

function parsePattern(text: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")
      ? value
      : undefined;
  } catch {
    // Not a plain list of string literals (e.g. a union `["view", "list"]` element): keep the line verbatim.
    return undefined;
  }
}

/** Inverse mapping used by import: an exact prefix rule is the glob `<prefix> *`. */
export function prefixToCapability(rule: PrefixRule): { list: PermissionLevel; cap: Capability } {
  return {
    list: rule.decision === "forbidden" ? "deny" : "ask",
    cap: { shell: `${rule.pattern.join(" ")} *` },
  };
}
