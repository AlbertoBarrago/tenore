import { isPlainObject } from "../../ir/canonical.ts";
import type { Warning } from "../../ir/diagnostics.ts";
import type { Capability, Ir, McpServer, PermissionLevel } from "../../ir/schema.ts";
import type { EmitContext } from "../types.ts";

/**
 * Keys of `config.toml` tenore owns. `mcp_servers` is owned whole so a removed
 * server disappears instead of lingering as a half-managed table.
 */
export const OWNED_CONFIG_KEYS = [
  "approval_policy",
  "web_search",
  "sandbox_workspace_write.network_access",
  "mcp_servers",
] as const;

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/;

/**
 * Builds the owned part of `config.toml` for one scope from that scope's IR.
 * Codex merges its config layers natively (project over user), like Claude
 * merges settings files, so each scope only describes itself.
 */
export function codexConfig(
  ir: Ir,
  ctx: EmitContext,
  warnings: Warning[],
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const raw = isPlainObject(ir.overrides.codex) ? ir.overrides.codex : {};

  if (ctx.layer.policy.permissions?.default !== undefined) {
    const level = ir.permissions.default;
    if (level === "allow") {
      warnings.push({
        code: "codex-default-allow",
        message: 'default "allow" has no safe Codex equivalent; approval_policy stays "on-request"',
      });
    }
    config.approval_policy = level === "deny" ? "never" : "on-request";
  }
  // Raw values (from import) fill gaps only; they never replace an explicit IR rule.
  if (raw.approval_policy !== undefined && config.approval_policy === undefined) {
    config.approval_policy = raw.approval_policy;
  }

  const network = networkLevel(ir);
  if (network === "none" || network === "restricted") {
    // "restricted" has no domain list in the IR; Codex domain rules need the
    // network proxy feature. Fall back to no shell network and cached search.
    config.web_search = network === "none" ? "disabled" : "cached";
    config.sandbox_workspace_write = { network_access: false };
    if (network === "restricted") {
      warnings.push({
        code: "codex-network-restricted",
        message:
          'network "restricted" becomes no sandbox network and cached-only web search in Codex',
      });
    }
  }
  if (raw.web_search !== undefined && network === undefined) config.web_search = raw.web_search;
  // A raw value is only a round-trip store: it never loosens an IR network rule.
  if (typeof raw.network_access === "boolean" && network === undefined) {
    config.sandbox_workspace_write = { network_access: raw.network_access };
  }

  const servers = mcpServers(ir, warnings);
  const rawServers = isPlainObject(raw.mcp_servers) ? raw.mcp_servers : {};
  const all = { ...servers, ...rawServers };
  if (Object.keys(all).length > 0) {
    config.mcp_servers = Object.fromEntries(
      Object.keys(all)
        .sort()
        .map((k) => [k, all[k]]),
    );
  }
  return config;
}

function networkLevel(ir: Ir): "none" | "restricted" | "full" | undefined {
  for (const list of ["deny", "ask", "allow"] as const) {
    for (const cap of ir.permissions[list]) if ("network" in cap) return cap.network;
  }
  return undefined;
}

/** Servers of this scope, with the MCP capabilities of this scope applied to them. */
function mcpServers(ir: Ir, warnings: Warning[]): Record<string, unknown> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(ir.mcp)) {
    const converted = toCodexServer(name, server, warnings);
    if (converted) out[name] = converted;
  }

  for (const list of ["deny", "ask", "allow"] as const) {
    for (const cap of ir.permissions[list]) {
      if (!("mcp" in cap)) continue;
      const [server = "", tool = "*"] = splitRef(cap.mcp);
      const target = out[server];
      if (!target) {
        warnings.push({
          code: "codex-mcp-policy-orphan",
          message: `${list} ${cap.mcp}: server "${server}" is not declared in this scope, rule not ${list === "deny" ? "ENFORCED" : "emitted"} for Codex`,
        });
        continue;
      }
      applyMcpRule(target, list, tool);
    }
  }
  return out;
}

/**
 * deny:  tool -> disabled_tools, server -> enabled = false
 * ask:   approval_mode / default_tools_approval_mode = "prompt"
 * allow: approval_mode / default_tools_approval_mode = "approve"
 * Lists are visited deny first, so a stronger rule is never overwritten.
 */
function applyMcpRule(server: Record<string, unknown>, list: PermissionLevel, tool: string): void {
  if (list === "deny") {
    if (tool === "*") server.enabled = false;
    else server.disabled_tools = [...((server.disabled_tools as string[] | undefined) ?? []), tool];
    return;
  }
  const mode = list === "ask" ? "prompt" : "approve";
  if (tool === "*") {
    server.default_tools_approval_mode ??= mode;
    return;
  }
  if (((server.disabled_tools as string[] | undefined) ?? []).includes(tool)) return;
  const tools = (server.tools as Record<string, Record<string, unknown>> | undefined) ?? {};
  tools[tool] ??= {};
  (tools[tool] as Record<string, unknown>).approval_mode ??= mode;
  server.tools = tools;
}

/**
 * Codex does not expand placeholders in `env`; it forwards variables listed in
 * `env_vars` from its own environment. So `KEY: ${env:KEY}` is exact, while a
 * renamed variable, or a placeholder in command/args, cannot be expressed
 * without resolving it: the server is skipped (never resolved).
 */
export function toCodexServer(
  name: string,
  server: McpServer,
  warnings: Warning[],
): Record<string, unknown> | undefined {
  const skip = (why: string) => {
    warnings.push({
      code: "codex-mcp-env-unsupported",
      message: `MCP server "${name}" not emitted for Codex: ${why}`,
    });
    return undefined;
  };
  if (ENV_REF.test(server.command) || (server.args ?? []).some((a) => ENV_REF.test(a))) {
    return skip("${env:...} in command or args");
  }
  const env: Record<string, string> = {};
  const envVars: string[] = [];
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (value === `\${env:${key}}`) envVars.push(key);
    else if (ENV_REF.test(value))
      return skip(`env ${key} = "${value}" renames or embeds a variable`);
    else env[key] = value;
  }
  return {
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(envVars.length > 0 ? { env_vars: envVars } : {}),
  };
}

function splitRef(ref: string): [string, string] {
  const dot = ref.indexOf(".");
  return [ref.slice(0, dot), ref.slice(dot + 1)];
}

/** Filesystem capabilities need beta permission profiles; not emitted for now. */
export function fsWarnings(ir: Ir): Warning[] {
  const warnings: Warning[] = [];
  for (const list of ["deny", "ask", "allow"] as const) {
    for (const cap of ir.permissions[list] as Capability[]) {
      if (!("fs.read" in cap) && !("fs.write" in cap)) continue;
      const glob = "fs.read" in cap ? cap["fs.read"] : cap["fs.write"];
      warnings.push({
        code: "codex-fs-unsupported",
        message:
          list === "deny"
            ? `deny ${"fs.read" in cap ? "fs.read" : "fs.write"} "${glob}" is NOT ENFORCED by Codex (needs beta permission profiles)`
            : `${list} on "${glob}" is not emitted for Codex (sandbox defaults apply)`,
      });
    }
  }
  return warnings;
}
