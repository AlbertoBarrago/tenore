import type { Ir } from "../../ir/schema.ts";
import type { ImportContext } from "../types.ts";

/** Reads Claude Code native files back into IR. Implemented in the next step. */
export async function importClaude(_root: string, _ctx: ImportContext): Promise<Partial<Ir>> {
  throw new Error("claude import is not implemented yet");
}
