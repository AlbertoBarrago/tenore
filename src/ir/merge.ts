import { canonicalKey, dedupe, isPlainObject } from "./canonical.ts";
import type { Warning } from "./diagnostics.ts";
import type { Layer } from "./parse.ts";
import {
  type Capability,
  DEFAULT_PERMISSION,
  type Ir,
  IrSchema,
  type NetworkLevel,
  type PermissionLevel,
  SCOPES,
  type Scope,
} from "./schema.ts";

export interface MergeResult {
  ir: Ir;
  /** Layer warnings plus every rule dropped by precedence, so nothing disappears silently. */
  warnings: Warning[];
}

type ListName = PermissionLevel;
const LISTS: readonly ListName[] = ["allow", "ask", "deny"];

/** Lower is more restrictive. */
const NETWORK_RANK: Record<NetworkLevel, number> = { none: 0, restricted: 1, full: 2 };

/**
 * Merges layers global -> repo -> local into one IR. Deterministic: the output
 * depends only on layer contents, never on input order or object key order.
 *
 * Precedence, at any scope: deny > ask > allow. A capability that appears in a
 * stronger list is removed from the weaker ones (with a warning). Scalars take
 * the narrowest scope that sets them. `network` is a scalar that lives inside
 * the lists and has its own rule, see {@link resolveNetwork}.
 */
export function mergeLayers(input: readonly Layer[]): MergeResult {
  const layers = [...input].sort((a, b) => scopeIndex(a.scope) - scopeIndex(b.scope));
  const warnings: Warning[] = layers.flatMap((l) => l.warnings);

  const network = resolveNetwork(layers, warnings);
  const collected = Object.fromEntries(
    LISTS.map((list) => [
      list,
      dedupe(
        layers.flatMap((l) =>
          (l.policy.permissions?.[list] ?? []).filter(
            (cap) => !("network" in cap) || (network?.list === list && network.cap === cap),
          ),
        ),
      ),
    ]),
  ) as Record<ListName, Capability[]>;

  const deny = collected.deny;
  const ask = shadow(collected.ask, deny, "shadowed-by-deny", warnings);
  const allow = shadow(
    shadow(collected.allow, deny, "shadowed-by-deny", warnings),
    ask,
    "shadowed-by-ask",
    warnings,
  );

  let defaultLevel: PermissionLevel = DEFAULT_PERMISSION;
  for (const l of layers) defaultLevel = l.policy.permissions?.default ?? defaultLevel;

  const mcp: Ir["mcp"] = {};
  for (const l of layers) Object.assign(mcp, l.policy.mcp);

  let targets: Ir["targets"];
  for (const l of layers) targets = l.policy.targets ?? targets;

  let overrides: Record<string, unknown> = {};
  for (const l of layers) overrides = deepMerge(overrides, l.policy.overrides ?? {});

  const ir = IrSchema.parse({
    version: 1,
    instructions: layers.flatMap((l) => l.instructions),
    memory: layers.flatMap((l) => l.memory),
    permissions: { default: defaultLevel, allow, ask, deny },
    mcp: Object.fromEntries(
      Object.keys(mcp)
        .sort()
        .map((k) => [k, mcp[k]]),
    ),
    ...(targets ? { targets } : {}),
    overrides,
  });
  return { ir, warnings };
}

/** Drops from `weaker` every capability present in `stronger`, warning for each one. */
function shadow(
  weaker: Capability[],
  stronger: Capability[],
  code: "shadowed-by-deny" | "shadowed-by-ask",
  warnings: Warning[],
): Capability[] {
  const keys = new Set(stronger.map(canonicalKey));
  return weaker.filter((cap) => {
    if (!keys.has(canonicalKey(cap))) return true;
    warnings.push({
      code,
      message: `${canonicalKey(cap)} is overridden by ${code === "shadowed-by-deny" ? "a deny" : "an ask"} rule`,
    });
    return false;
  });
}

interface NetworkEntry {
  scope: number;
  list: ListName;
  level: NetworkLevel;
  /** Identity of the source object, used to keep exactly this entry in its list. */
  cap: Capability;
}

/**
 * Picks the single effective `network` capability.
 *
 * - Any deny, at any scope, locks the setting: the most restrictive denied
 *   level wins (a narrower scope cannot loosen a wider deny).
 * - Otherwise the narrowest scope wins, like any scalar; within one scope ask
 *   beats allow.
 */
function resolveNetwork(layers: readonly Layer[], warnings: Warning[]): NetworkEntry | undefined {
  const entries: NetworkEntry[] = [];
  for (const l of layers) {
    for (const list of LISTS) {
      for (const cap of l.policy.permissions?.[list] ?? []) {
        if ("network" in cap)
          entries.push({ scope: scopeIndex(l.scope), list, level: cap.network, cap });
      }
    }
  }
  if (entries.length === 0) return undefined;

  const denies = entries.filter((e) => e.list === "deny");
  if (denies.length > 0) {
    const winner = denies.reduce((best, e) =>
      NETWORK_RANK[e.level] < NETWORK_RANK[best.level] ? e : best,
    );
    if (entries.length > 1) {
      warnings.push({
        code: "network-locked-by-deny",
        message: `network is locked to "${winner.level}" by a deny rule (${SCOPES[winner.scope]} scope)`,
      });
    }
    return winner;
  }
  const narrowest = Math.max(...entries.map((e) => e.scope));
  const candidates = entries.filter((e) => e.scope === narrowest);
  return candidates.find((e) => e.list === "ask") ?? candidates[0];
}

/** Narrower (`b`) wins on scalars and type mismatches; objects recurse; arrays concat + dedupe. */
function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) out[key] = deepMerge(prev, value);
    else if (Array.isArray(prev) && Array.isArray(value)) out[key] = dedupe([...prev, ...value]);
    else out[key] = value;
  }
  return out;
}

function scopeIndex(scope: Scope): number {
  return SCOPES.indexOf(scope);
}
