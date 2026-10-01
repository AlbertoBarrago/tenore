import type { Adapter, Artifact, EmitContext } from "../adapters/types.ts";
import type { Warning } from "../ir/diagnostics.ts";
import { mergeLayers } from "../ir/merge.ts";
import type { Layer } from "../ir/parse.ts";
import type { Scope } from "../ir/schema.ts";

export interface Compiled {
  scope: Scope;
  artifacts: Artifact[];
  warnings: Warning[];
}

/**
 * Runs one adapter for each requested scope. Each scope is emitted from its own
 * layer (Claude merges settings files natively, deny first), while `merged`
 * gives adapters the whole picture and drives the shared merge warnings.
 */
export async function compile(
  adapter: Adapter,
  layers: readonly Layer[],
  scopes: readonly Scope[],
  root: string,
  home: string,
): Promise<{ compiled: Compiled[]; warnings: Warning[] }> {
  const merged = mergeLayers(layers);
  const compiled: Compiled[] = [];
  for (const scope of scopes) {
    const layer = layers.find((l) => l.scope === scope);
    if (!layer) continue;
    const ir = mergeLayers([{ ...layer, warnings: [] }]).ir;
    const ctx: EmitContext = { scope, root, home, layer, merged: merged.ir };
    compiled.push({
      scope,
      artifacts: await adapter.emit(ir, ctx),
      warnings: adapter.lossy(ir, ctx),
    });
  }
  return { compiled, warnings: merged.warnings };
}
