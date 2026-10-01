import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claude } from "../src/adapters/claude.ts";
import { SourceError } from "../src/ir/diagnostics.ts";
import type { Scope } from "../src/ir/schema.ts";
import { withHeader } from "../src/sync/hash.ts";
import { FIXTURES, writeTree } from "./helpers.ts";

const importScope = (root: string, home: string, scope: Scope) =>
  claude.import(root, { scope, root, home });

describe("claude import: existing global config (fixture claude-global)", () => {
  const home = join(FIXTURES, "claude-global/home");
  const claudeMd = join(home, ".claude/CLAUDE.md");

  it("keeps the hand-written CLAUDE.md verbatim as one instruction block", async () => {
    const result = await importScope("/nonexistent", home, "global");
    expect(result.instructions).toEqual([
      { source: claudeMd, scope: "global", body: readFileSync(claudeMd, "utf8") },
    ]);
  });

  it("preserves the instruction semantics: reply language and the two gates", async () => {
    const body = (await importScope("/nonexistent", home, "global")).instructions[0]?.body ?? "";
    expect(body).toContain("**Reply in Italian**");
    expect(body).toContain("present a plan and wait for explicit confirmation");
    expect(body).toContain("Only after explicit user confirmation → `git commit` + `git push`");
    expect(body).toContain("Never commit autonomously");
  });

  it("maps known rules to capabilities and keeps the rest verbatim", async () => {
    const { policy } = await importScope("/nonexistent", home, "global");
    expect(policy).toEqual({
      permissions: {
        allow: [{ shell: "npm run test *" }, { "fs.read": ".env.example" }],
        deny: [
          { "fs.read": ".env*" },
          { shell: "git push --force*" },
          { mcp: "github.delete_repo" },
        ],
      },
      overrides: {
        claude: {
          permissions: { allow: ["WebFetch(domain:code.claude.com)"], defaultMode: "auto" },
        },
      },
    });
  });

  it("ignores settings keys it does not own", async () => {
    const { policy } = await importScope("/nonexistent", home, "global");
    expect(JSON.stringify(policy)).not.toMatch(/additionalDirectories|statusLine|hooks|opus/);
  });
});

describe("claude import: generated files", () => {
  it("resolves @ imports back to .agents sources", async () => {
    const root = await writeTree({
      ".agents/AGENTS.md": "repo rules\n",
      ".agents/memory/stack.md": "ts\n",
      "CLAUDE.md": withHeader("@.agents/AGENTS.md\n\n@.agents/memory/stack.md\n"),
    });
    const result = await importScope(root, "/nonexistent", "repo");
    expect(result.instructions).toEqual([
      { source: join(root, ".agents/AGENTS.md"), scope: "repo", body: "repo rules\n" },
    ]);
    expect(result.memory).toEqual([{ topic: "stack", scope: "repo", body: "ts\n" }]);
    expect(result.warnings).toEqual([]);
  });

  it("resolves ~/ imports in the global CLAUDE.md", async () => {
    const home = await writeTree({
      ".agents/AGENTS.md": "global\n",
      ".claude/CLAUDE.md": withHeader("@~/.agents/AGENTS.md\n"),
    });
    const result = await importScope("/nonexistent", home, "global");
    expect(result.instructions).toEqual([
      { source: join(home, ".agents/AGENTS.md"), scope: "global", body: "global\n" },
    ]);
  });

  it("warns on missing and foreign imports", async () => {
    const root = await writeTree({
      "docs/extra.md": "extra\n",
      "CLAUDE.md": withHeader("@.agents/AGENTS.md\n@docs/extra.md\n"),
    });
    const result = await importScope(root, "/nonexistent", "repo");
    expect(result.warnings.map((w) => w.code)).toEqual([
      "claude-import-missing",
      "claude-import-foreign",
    ]);
    expect(result.instructions.map((i) => i.body)).toEqual(["extra\n"]);
  });

  it("local scope reads CLAUDE.local.md and settings.local.json", async () => {
    const root = await writeTree({
      ".agents/local/AGENTS.md": "local\n",
      "CLAUDE.local.md": withHeader("@.agents/local/AGENTS.md\n"),
      ".claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(make*)"] } }),
    });
    const result = await importScope(root, "/nonexistent", "local");
    expect(result.instructions.map((i) => i.body)).toEqual(["local\n"]);
    expect(result.policy).toEqual({ permissions: { allow: [{ shell: "make*" }] } });
  });
});

describe("claude import: settings edge cases", () => {
  async function importSettings(permissions: unknown) {
    const root = await writeTree({ ".claude/settings.json": JSON.stringify({ permissions }) });
    return (await importScope(root, "/nonexistent", "repo")).policy;
  }

  it.each([
    ["deny", "none"],
    ["ask", "restricted"],
  ])("WebFetch + WebSearch in %s -> network %s", async (list, level) => {
    expect(await importSettings({ [list]: ["WebSearch", "Read(x)", "WebFetch"] })).toEqual({
      permissions: { [list]: [{ network: level }, { "fs.read": "x" }] },
    });
  });

  it("a lone WebFetch, or web tools in allow, stay raw", async () => {
    expect(await importSettings({ deny: ["WebFetch"], allow: ["WebFetch", "WebSearch"] })).toEqual({
      overrides: {
        claude: { permissions: { deny: ["WebFetch"], allow: ["WebFetch", "WebSearch"] } },
      },
    });
  });

  it.each([
    ["default", { permissions: { default: "ask" } }],
    ["dontAsk", { permissions: { default: "deny" } }],
    ["plan", { overrides: { claude: { permissions: { defaultMode: "plan" } } } }],
  ])("defaultMode %s", async (mode, expected) => {
    expect(await importSettings({ defaultMode: mode })).toEqual(expected);
  });

  it("dedupes repeated rules", async () => {
    expect(await importSettings({ allow: ["Bash(ls*)", "Bash(ls*)"] })).toEqual({
      permissions: { allow: [{ shell: "ls*" }] },
    });
  });

  it.each([
    ["not an object", { permissions: [] }],
    ["non-string rule", { permissions: { allow: [1] } }],
  ])("rejects malformed settings: %s", async (_name, settings) => {
    const root = await writeTree({ ".claude/settings.json": JSON.stringify(settings) });
    await expect(importScope(root, "/nonexistent", "repo")).rejects.toBeInstanceOf(SourceError);
  });

  it("reports invalid JSON as a SourceError", async () => {
    const root = await writeTree({ ".claude/settings.json": "{ nope" });
    await expect(importScope(root, "/nonexistent", "repo")).rejects.toThrow(/invalid JSON/);
  });
});

describe("claude import: .mcp.json", () => {
  async function importMcpJson(mcpServers: unknown) {
    const root = await writeTree({ ".mcp.json": JSON.stringify({ mcpServers }) });
    return importScope(root, "/nonexistent", "repo");
  }

  it("translates ${VAR} back to ${env:VAR}", async () => {
    const { policy } = await importMcpJson({
      gh: {
        type: "stdio",
        command: "npx",
        args: ["--t=${GH}"],
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      },
    });
    expect(policy.mcp).toEqual({
      gh: { command: "npx", args: ["--t=${env:GH}"], env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" } },
    });
  });

  it("keeps remote, defaulted-placeholder and badly named servers raw", async () => {
    const servers = {
      remote: { type: "http", url: "https://example.com/mcp" },
      defaulted: { command: "x", env: { A: "${A:-1}" } },
      "bad.name": { command: "x" },
    };
    const { policy } = await importMcpJson(servers);
    expect(policy.mcp).toBeUndefined();
    expect(policy.overrides?.claude?.mcpServers).toEqual(servers);
  });

  it("flags literal secrets", async () => {
    const { warnings } = await importMcpJson({
      gh: { command: "x", env: { GITHUB_TOKEN: "ghp_abc" } },
    });
    expect(warnings.map((w) => w.code)).toEqual(["mcp-literal-secret"]);
  });
});
