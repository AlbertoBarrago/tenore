import { access } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isPlainObject } from "../ir/canonical.ts";
import type { Warning } from "../ir/diagnostics.ts";
import type { InstructionBlock, Ir, MemoryBlock, Scope } from "../ir/schema.ts";
import { withHeader } from "../sync/hash.ts";
import { serializeDocument } from "../sync/write.ts";
import { codexConfig, fsWarnings, OWNED_CONFIG_KEYS, toCodexServer } from "./codex/config.ts";
import { importCodex } from "./codex/import.ts";
import { renderBlocks } from "./codex/instructions.ts";
import { codexPaths } from "./codex/paths.ts";
import { PROFILE_KEYS, profilesEnabled } from "./codex/profiles.ts";
import { globToPrefix, renderRules, toPrefixRules } from "./codex/rules.ts";
import type { Adapter, Artifact, EmitContext } from "./types.ts";

/** Codex CLI: `AGENTS.md` (copied, no imports), `config.toml` (merged keys), `.rules` (owned). */
export const codex: Adapter = {
  id: "codex",

  expresses: {
    capability(cap, list, scope) {
      if (scope === "local" || "fs.read" in cap || "fs.write" in cap) return undefined;
      if ("network" in cap) {
        if (cap.network === "full") return undefined;
        return { list: cap.network === "none" ? "deny" : "ask", cap };
      }
      if ("shell" in cap) {
        if (list === "allow") return undefined;
        const { pattern } = globToPrefix(cap.shell);
        return pattern.length === 0
          ? undefined
          : { list, cap: { shell: `${pattern.join(" ")} *` } };
      }
      return { list, cap };
    },
    server: (name, server, scope) =>
      scope !== "local" && toCodexServer(name, server, []) !== undefined,
  },

  async detect(root) {
    for (const p of ["AGENTS.md", ".codex", "AGENTS.override.md"]) {
      if (await exists(join(root, p))) return true;
    }
    return false;
  },

  async emit(ir, ctx) {
    return compile(ir, ctx).artifacts;
  },

  import(root, ctx) {
    return importCodex(root, ctx);
  },

  lossy(ir, ctx) {
    return compile(ir, ctx).warnings;
  },
};

function compile(ir: Ir, ctx: EmitContext): { artifacts: Artifact[]; warnings: Warning[] } {
  const paths = codexPaths(ctx.scope, ctx.root, ctx.home);
  const artifacts: Artifact[] = [];
  const warnings: Warning[] = [];

  const instructions = instructionsFile(ir, ctx);
  if (instructions !== undefined) {
    artifacts.push({ path: paths.instructions, content: instructions, strategy: "owned" });
  }

  if (paths.config === undefined || paths.rules === undefined) {
    const p = ir.permissions;
    if (p.deny.length + p.ask.length > 0) {
      warnings.push({
        code: "codex-local-policy-unsupported",
        message:
          "Codex has no local config layer: local deny/ask rules are NOT ENFORCED in Codex (move them to .agents/policy.md)",
      });
    } else if (hasPolicy(ir)) {
      // Not granting an allow (or not starting a server) is the restrictive side: informational only.
      warnings.push({
        code: "codex-local-allow-ignored",
        message:
          "Codex has no local config layer: local allow rules and MCP servers are not applied (Codex keeps asking); only Claude uses them",
      });
    }
    return { artifacts, warnings };
  }

  const config = codexConfig(ir, ctx, warnings);
  if (Object.keys(config).length > 0) {
    artifacts.push({
      path: paths.config,
      content: serializeDocument("toml", config),
      strategy: {
        mergeKeys: [...OWNED_CONFIG_KEYS, ...(profilesEnabled(ir) ? PROFILE_KEYS : [])],
        format: "toml",
      },
    });
  }

  const shell = toPrefixRules(ir.permissions);
  warnings.push(...shell.warnings, ...(profilesEnabled(ir) ? [] : fsWarnings(ir)));
  const rawRules =
    isPlainObject(ir.overrides.codex) && typeof ir.overrides.codex.rules === "string"
      ? ir.overrides.codex.rules
      : "";
  const rules = renderRules(shell.rules) + rawRules;
  if (rules !== "")
    artifacts.push({ path: paths.rules, content: withHeader(rules, "hash"), strategy: "owned" });

  if (
    ctx.scope === "repo" &&
    artifacts.some((a) => a.path === paths.config || a.path === paths.rules)
  ) {
    warnings.push({
      code: "codex-project-trust",
      message:
        "Codex loads .codex/config.toml and .codex/rules only for trusted projects (projects.<path>.trust_level)",
    });
  }
  return { artifacts, warnings };
}

/**
 * Global and repo scopes copy their own blocks. The local scope writes
 * `AGENTS.override.md`, which *replaces* `AGENTS.md` in Codex's discovery, so
 * it must carry the repo blocks too.
 */
function instructionsFile(ir: Ir, ctx: EmitContext): string | undefined {
  const own = (xs: { scope: Scope }[]) => xs.some((x) => x.scope === ctx.scope);
  if (!own(ir.instructions) && !own(ir.memory)) return undefined;

  const scopes: Scope[] = ctx.scope === "local" ? ["repo", "local"] : [ctx.scope];
  const source = ctx.scope === "local" ? ctx.merged : ir;
  const instructions: InstructionBlock[] = source.instructions.filter((i) =>
    scopes.includes(i.scope),
  );
  const memory: MemoryBlock[] = source.memory.filter((m) => scopes.includes(m.scope));
  const base = ctx.scope === "global" ? ctx.home : ctx.root;
  const refs = instructions.map((block) => ({ block, ref: toPosix(relative(base, block.source)) }));
  return withHeader(renderBlocks(refs, memory));
}

function hasPolicy(ir: Ir): boolean {
  const p = ir.permissions;
  return p.allow.length + p.ask.length + p.deny.length > 0 || Object.keys(ir.mcp).length > 0;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // access() signals absence (or no permission) only by throwing; both mean "not detected".
    return false;
  }
}
