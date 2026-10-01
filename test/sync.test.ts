import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claude } from "../src/adapters/claude.ts";
import { parseLayers } from "../src/ir/parse.ts";
import type { Scope } from "../src/ir/schema.ts";
import { renderDiff } from "../src/sync/diff.ts";
import { withHeader } from "../src/sync/hash.ts";
import { applyPlan, planSync } from "../src/sync/plan.ts";
import { readOptional } from "../src/sync/write.ts";
import { writeTree } from "./helpers.ts";

const POLICY = [
  "---",
  "permissions:",
  "  allow: [{ shell: 'npm test*' }]",
  "mcp:",
  "  gh: { command: npx }",
  "---",
  "",
].join("\n");

async function repo(extra: Record<string, string> = {}) {
  const root = await writeTree({
    ".agents/AGENTS.md": "rules\n",
    ".agents/policy.md": POLICY,
    ...extra,
  });
  return { root, home: await writeTree({}) };
}

async function plan(root: string, home: string, scopes: Scope[] = ["repo", "local"]) {
  return planSync([claude], await parseLayers(root, home), scopes, root, home);
}

async function sync(root: string, home: string, scopes?: Scope[]) {
  const p = await plan(root, home, scopes);
  await applyPlan(p);
  return p;
}

const kinds = (p: Awaited<ReturnType<typeof plan>>, root: string) =>
  Object.fromEntries(p.actions.map((a) => [a.path.slice(root.length + 1), a.kind]));

const read = (root: string, rel: string) => readFile(join(root, rel), "utf8");

describe("sync: fresh repo", () => {
  it("creates artifacts and a committed lock, then is a no-op", async () => {
    const { root, home } = await repo();
    const first = await sync(root, home);
    expect(kinds(first, root)).toEqual({
      "CLAUDE.md": "create",
      ".claude/settings.json": "create",
      ".mcp.json": "create",
    });
    const lock = JSON.parse(await read(root, ".agents/.lock"));
    expect(Object.keys(lock.artifacts)).toEqual([
      ".claude/settings.json",
      ".mcp.json",
      "CLAUDE.md",
    ]);
    expect(lock.artifacts[".claude/settings.json"]).toMatchObject({
      adapter: "claude",
      strategy: "merge",
    });

    const second = await plan(root, home);
    expect(new Set(second.actions.map((a) => a.kind))).toEqual(new Set(["unchanged"]));
    expect(second.locks).toEqual([]);
  });

  it("writes no local lock when the local scope emits nothing", async () => {
    const { root, home } = await repo();
    await sync(root, home);
    expect(await readOptional(join(root, ".agents/local/.lock"))).toBeUndefined();
  });

  it("does not touch the global scope unless asked", async () => {
    const { root } = await repo();
    const home = await writeTree({ ".agents/AGENTS.md": "global\n" });
    await sync(root, home);
    expect(await readOptional(join(home, ".claude/CLAUDE.md"))).toBeUndefined();
    await sync(root, home, ["global"]);
    expect(await read(home, ".claude/CLAUDE.md")).toContain("@~/.agents/AGENTS.md");
    expect(JSON.parse(await read(home, ".agents/.lock")).artifacts).toHaveProperty([
      ".claude/CLAUDE.md",
    ]);
  });
});

describe("sync: never overwrites what it did not generate", () => {
  it("a hand-written CLAUDE.md is a conflict", async () => {
    const { root, home } = await repo({ "CLAUDE.md": "my own notes\n" });
    const p = await sync(root, home);
    expect(kinds(p, root)["CLAUDE.md"]).toBe("conflict");
    expect(await read(root, "CLAUDE.md")).toBe("my own notes\n");
    expect(JSON.parse(await read(root, ".agents/.lock")).artifacts).not.toHaveProperty([
      "CLAUDE.md",
    ]);
  });

  it("an existing settings.json with its own permissions is a conflict", async () => {
    const { root, home } = await repo({
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(rm*)"] } }),
    });
    const p = await sync(root, home);
    expect(kinds(p, root)[".claude/settings.json"]).toBe("conflict");
    expect(JSON.parse(await read(root, ".claude/settings.json"))).toEqual({
      permissions: { allow: ["Bash(rm*)"] },
    });
  });

  it("an existing settings.json without owned keys is adopted, other keys kept", async () => {
    const { root, home } = await repo({
      ".claude/settings.json": JSON.stringify({
        model: "opus",
        permissions: { additionalDirectories: ["x"] },
      }),
    });
    const p = await sync(root, home);
    expect(kinds(p, root)[".claude/settings.json"]).toBe("update");
    expect(JSON.parse(await read(root, ".claude/settings.json"))).toEqual({
      model: "opus",
      permissions: { additionalDirectories: ["x"], allow: ["Bash(npm test*)"] },
    });
  });

  it("a generated file whose lock entry was lost is adopted via its header", async () => {
    const { root, home } = await repo({ "CLAUDE.md": withHeader("@.agents/OLD.md\n") });
    const p = await sync(root, home);
    expect(kinds(p, root)["CLAUDE.md"]).toBe("update");
  });

  it("invalid JSON in a shared file is a conflict, left untouched", async () => {
    const { root, home } = await repo({ ".claude/settings.json": "{ nope" });
    const p = await sync(root, home);
    expect(p.actions.find((a) => a.path.endsWith("settings.json"))).toMatchObject({
      kind: "conflict",
      reason: expect.stringMatching(/invalid JSON/),
    });
    expect(await read(root, ".claude/settings.json")).toBe("{ nope");
  });
});

describe("sync: drift", () => {
  it("an edited generated file is reported and kept; the lock keeps the old hash", async () => {
    const { root, home } = await repo();
    await sync(root, home);
    const lockBefore = await read(root, ".agents/.lock");
    await writeFile(join(root, "CLAUDE.md"), `${await read(root, "CLAUDE.md")}extra\n`);
    await writeFile(join(root, ".agents/AGENTS.md"), "changed\n");

    const p = await sync(root, home);
    expect(kinds(p, root)["CLAUDE.md"]).toBe("drift");
    expect(await read(root, "CLAUDE.md")).toMatch(/extra\n$/);
    expect(await read(root, ".agents/.lock")).toBe(lockBefore);
  });

  it("editing an owned settings key is drift, editing another key is not", async () => {
    const { root, home } = await repo();
    await sync(root, home);
    const settingsPath = join(root, ".claude/settings.json");
    const settings = JSON.parse(await read(root, ".claude/settings.json"));

    await writeFile(settingsPath, JSON.stringify({ ...settings, model: "sonnet" }));
    expect(kinds(await plan(root, home), root)[".claude/settings.json"]).toBe("unchanged");

    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));
    expect(kinds(await plan(root, home), root)[".claude/settings.json"]).toBe("drift");
  });

  it("a deleted generated file is recreated", async () => {
    const { root, home } = await repo();
    await sync(root, home);
    await rm(join(root, ".mcp.json"));
    expect(kinds(await plan(root, home), root)[".mcp.json"]).toBe("create");
  });
});

describe("sync: stale artifacts", () => {
  it("removes files and owned keys that are no longer generated", async () => {
    const { root, home } = await repo({
      ".claude/settings.json": JSON.stringify({ model: "opus" }),
    });
    await sync(root, home);
    await rm(join(root, ".agents/policy.md"));

    const p = await sync(root, home);
    expect(kinds(p, root)).toEqual({
      "CLAUDE.md": "unchanged",
      ".claude/settings.json": "remove",
      ".mcp.json": "remove",
    });
    expect(await readOptional(join(root, ".mcp.json"))).toBeUndefined();
    expect(JSON.parse(await read(root, ".claude/settings.json"))).toEqual({ model: "opus" });
    expect(Object.keys(JSON.parse(await read(root, ".agents/.lock")).artifacts)).toEqual([
      "CLAUDE.md",
    ]);
  });

  it("keeps a stale file that was edited, as drift", async () => {
    const { root, home } = await repo();
    await sync(root, home);
    await writeFile(join(root, ".mcp.json"), '{"mcpServers":{"mine":{"command":"x"}}}');
    await rm(join(root, ".agents/policy.md"));
    const p = await sync(root, home);
    expect(kinds(p, root)[".mcp.json"]).toBe("drift");
    expect(await readOptional(join(root, ".mcp.json"))).toBeDefined();
  });
});

describe("diff", () => {
  it("renders pending writes as a unified diff, without touching the disk", async () => {
    const { root, home } = await repo();
    const out = renderDiff(await plan(root, home), root);
    expect(out).toContain("# create\n--- /dev/null\n+++ b/CLAUDE.md");
    expect(out).toContain("+++ b/.agents/.lock");
    expect(out).toContain('+    "allow": [');
    expect(await readOptional(join(root, "CLAUDE.md"))).toBeUndefined();
  });

  it("is empty when everything is in sync", async () => {
    const { root, home } = await repo();
    await sync(root, home);
    expect(renderDiff(await plan(root, home), root)).toBe("");
  });
});
