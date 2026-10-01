import type { Warning } from "../../ir/diagnostics.ts";
import type { Capability, PermissionLevel, Permissions } from "../../ir/schema.ts";

/**
 * Capability <-> Antigravity permission resources `action(target)`.
 *
 * Verified against https://antigravity.google/docs/permissions (2026-10):
 * - deny > ask > allow, like the IR.
 * - `command(prefix)` matches word by word; `command(regex:...)` evaluates each
 *   whitespace-separated token as `^(?:token)$`. Both are prefix matches on
 *   the token list. `command(*)` matches every command.
 * - `read_file(path)` / `write_file(path)`: a path (file or directory,
 *   recursive), absolute or relative to the workspace root. No globs.
 * - `read_url(domain)` / `execute_url(domain)`: web access, also compiled into
 *   the terminal sandbox network allowlist.
 * - `mcp(server/tool)`, `mcp(server/*)`.
 */

export type Rules = Record<PermissionLevel, string[]>;
const LEVELS: readonly PermissionLevel[] = ["deny", "ask", "allow"];
const WILDCARD = /[*?[]/;
export const URL_ACTIONS = ["read_url(*)", "execute_url(*)"] as const;

export function toAntigravityRules(
  perms: Pick<Permissions, PermissionLevel>,
  home: string,
): { rules: Rules; warnings: Warning[] } {
  const rules: Rules = { allow: [], ask: [], deny: [] };
  const warnings: Warning[] = [];
  const push = (list: PermissionLevel, rule: string) => {
    if (!rules[list].includes(rule)) rules[list].push(rule);
  };

  for (const list of LEVELS) {
    for (const cap of perms[list] as Capability[]) {
      if ("mcp" in cap) {
        const dot = cap.mcp.indexOf(".");
        push(list, `mcp(${cap.mcp.slice(0, dot)}/${cap.mcp.slice(dot + 1)})`);
      } else if ("network" in cap) {
        if (cap.network === "full") continue;
        for (const rule of URL_ACTIONS) push(cap.network === "none" ? "deny" : "ask", rule);
      } else if ("shell" in cap) {
        const rule = shellRule(cap.shell, list, warnings);
        if (rule) push(list, rule);
      } else {
        const action = "fs.read" in cap ? "read_file" : "write_file";
        const glob = "fs.read" in cap ? cap["fs.read"] : cap["fs.write"];
        const target = fsTarget(glob, list, home, warnings);
        if (target) push(list, `${action}(${target})`);
      }
    }
  }
  return { rules, warnings };
}

/**
 * A glob token maps to an anchored token regex, so `npm run test*` is exact.
 * Antigravity tokens never span spaces, so a `*` token that is not the last
 * one cannot be expressed: deny/ask are cut to the prefix before it (broader,
 * safe), allow is dropped. A glob without a trailing wildcard is exact in the
 * IR but a prefix in Antigravity: fine for deny/ask, dropped for allow.
 */
export function shellRule(
  glob: string,
  list: PermissionLevel,
  warnings: Warning[],
): string | undefined {
  const tokens = glob
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "");
  if (tokens.length === 1 && tokens[0] === "*") return "command(*)";

  let cut = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "*" && i < tokens.length - 1) {
      cut = i;
      break;
    }
  }
  const trailingStar = tokens[tokens.length - 1] === "*" && cut === tokens.length;
  const kept = tokens.slice(0, trailingStar ? -1 : cut);
  const broadened = cut < tokens.length || (!trailingStar && !WILDCARD.test(tokens.at(-1) ?? ""));

  if (kept.length === 0) {
    warnings.push({
      code: "antigravity-shell-unexpressible",
      message: `${list} shell "${glob}" starts with a wildcard and is ${list === "deny" ? "NOT ENFORCED" : "not emitted"} for Antigravity`,
    });
    return undefined;
  }
  if (broadened && list === "allow") {
    warnings.push({
      code: "antigravity-shell-allow-dropped",
      message: `allow shell "${glob}" would match more commands in Antigravity (prefix match); not emitted`,
    });
    return undefined;
  }
  if (cut < tokens.length) {
    warnings.push({
      code: "antigravity-shell-broadened",
      message: `${list} shell "${glob}" is broadened to the prefix "${kept.join(" ")}" for Antigravity`,
    });
  }
  if (!kept.some((t) => WILDCARD.test(t))) return `command(${kept.join(" ")})`;
  return `command(regex:${kept.map(globTokenToRegex).join(" ")})`;
}

export function globTokenToRegex(token: string): string {
  let out = "";
  for (const ch of token) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += /[\\^$.|+(){}[\]]/.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/** Inverse of {@link globTokenToRegex}; `undefined` for regexes it did not produce. */
export function regexTokenToGlob(token: string): string | undefined {
  let out = "";
  for (let i = 0; i < token.length; i++) {
    const ch = token[i] as string;
    if (ch === "\\") {
      const next = token[i + 1];
      if (next === undefined || !/[\\^$.|+(){}[\]]/.test(next)) return undefined;
      out += next;
      i++;
    } else if (ch === "." && token[i + 1] === "*") {
      out += "*";
      i++;
    } else if (ch === ".") {
      out += "?";
    } else if (/[\^$|+(){}[\]*?]/.test(ch)) {
      return undefined;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * `src/**` -> `src/`, `/etc/**` -> `/etc/`, `~/x` -> `<home>/x`, exact paths
 * stay exact. Antigravity paths are recursive and root-anchored, so:
 * - any other glob has no form (deny NOT ENFORCED, allow/ask dropped);
 * - `dir/*` (direct children only) is broadened to `dir/` for deny/ask, dropped for allow;
 * - an unanchored name (`.env`, any depth in the IR) only covers the root: for
 *   deny that is narrower, so it is flagged.
 */
export function fsTarget(
  glob: string,
  list: PermissionLevel,
  home: string,
  warnings: Warning[],
): string | undefined {
  if (glob === "*" || glob === "**" || glob === "/**") return "*";
  let path = glob.startsWith("~/") ? `${home}/${glob.slice(2)}` : glob;

  if (path.endsWith("/**")) path = `${path.slice(0, -3)}/`;
  else if (path.endsWith("/*")) {
    if (list === "allow") {
      warnings.push({
        code: "antigravity-fs-allow-dropped",
        message: `allow "${glob}" would also cover nested files in Antigravity; not emitted`,
      });
      return undefined;
    }
    path = `${path.slice(0, -2)}/`;
  }
  if (WILDCARD.test(path)) {
    warnings.push({
      code: "antigravity-fs-unexpressible",
      message: `${list} "${glob}" uses a glob Antigravity paths cannot express; ${list === "deny" ? "NOT ENFORCED" : "not emitted"}`,
    });
    return undefined;
  }
  const unanchored =
    !glob.startsWith("/") && !glob.startsWith("~/") && !glob.replace(/\/+$/, "").includes("/");
  if (unanchored && list === "deny") {
    warnings.push({
      code: "antigravity-fs-root-only",
      message: `deny "${glob}" applies at any depth in tenore but only at the workspace root in Antigravity`,
    });
  }
  return path;
}

/** Parses one rule; `undefined` keeps it verbatim in overrides. */
export function fromAntigravityRule(rule: string, home: string): Capability | undefined {
  const m = /^([a-z_]+)\((.*)\)$/s.exec(rule);
  if (!m) return undefined;
  const [, action, target = ""] = m;
  if (action === "mcp") {
    const mcp = /^([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)\/(\*|[A-Za-z0-9_-]+)$/.exec(target);
    return mcp ? { mcp: `${mcp[1]}.${mcp[2]}` } : undefined;
  }
  if (action === "command") {
    if (target === "*") return { shell: "*" };
    if (target.startsWith("regex:")) {
      const tokens = target.slice(6).split(/\s+/).map(regexTokenToGlob);
      if (tokens.length === 0 || tokens.some((t) => t === undefined || t === "")) return undefined;
      const last = tokens.at(-1) as string;
      return { shell: WILDCARD.test(last) ? tokens.join(" ") : `${tokens.join(" ")} *` };
    }
    return target === "" || WILDCARD.test(target) ? undefined : { shell: `${target} *` };
  }
  if (action === "read_file" || action === "write_file") {
    if (target === "" || (WILDCARD.test(target) && target !== "*")) return undefined;
    let glob = target === "*" ? "**" : target.endsWith("/") ? `${target}**` : target;
    if (glob.startsWith(`${home}/`)) glob = `~/${glob.slice(home.length + 1)}`;
    return action === "read_file" ? { "fs.read": glob } : { "fs.write": glob };
  }
  return undefined;
}
