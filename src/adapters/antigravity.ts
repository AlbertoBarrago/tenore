import type { Adapter } from "./types.ts";

/** Antigravity adapter: stub, out of scope for phase 1. Emits nothing and says so. */
export const antigravity: Adapter = {
  id: "antigravity",
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
      { code: "adapter-not-implemented", message: "Antigravity adapter is not implemented yet" },
    ];
  },
};
