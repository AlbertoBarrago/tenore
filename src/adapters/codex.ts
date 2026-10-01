import type { Adapter } from "./types.ts";

/** Codex CLI adapter: stub, out of scope for phase 1. Emits nothing and says so. */
export const codex: Adapter = {
  id: "codex",
  async detect() {
    return false;
  },
  async emit() {
    return [];
  },
  async import() {
    return { instructions: [], memory: [], policy: {}, warnings: [] };
  },
  lossy() {
    return [
      { code: "adapter-not-implemented", message: "Codex CLI adapter is not implemented yet" },
    ];
  },
};
