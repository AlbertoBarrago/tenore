import type { Adapter } from "./types.ts";

/** Gemini CLI adapter: stub, out of scope for phase 1. Emits nothing and says so. */
export const gemini: Adapter = {
  id: "gemini",
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
      { code: "adapter-not-implemented", message: "Gemini CLI adapter is not implemented yet" },
    ];
  },
};
