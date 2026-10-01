import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claude } from "../src/adapters/claude.ts";
import type { EmitContext } from "../src/adapters/types.ts";
import { mergeLayers } from "../src/ir/merge.ts";
import { type Layer, parseLayers } from "../src/ir/parse.ts";
import type { Scope } from "../src/ir/schema.ts";
import { parseHeader, shortHash } from "../src/sync/hash.ts";
import { FIXTURES, writeTree } from "./helpers.ts";

async function contextFor(root: string, home: string, scope: Scope) {
  const layers = await parseLayers(root, home);
  const layer = layers.find((l) => l.scope === scope) as Layer;
  const ctx: EmitContext = { scope, root, home, layer, merged: mergeLayers(layers).ir };
  return { ir: mergeLayers([layer]).ir, ctx };
}

async function emitScope(root: string, home: string, scope: Scope) {
  const { ir, ctx } = await contextFor(root, home, scope);
  const artifacts = await claude.emit(ir, ctx);
  return { byPath: Object.fromEntries(artifacts.map((a) => [a.path, a])), artifacts, ir, ctx };
}

const root = join(FIXTURES, "basic/repo");
const home = join(FIXTURES, "basic/home");

describe("claude emit: repo scope (fixture basic)", () => {
  it("emits CLAUDE.md, settings.json and .mcp.json", async () => {
    const { artifacts } = await emitScope(root, home, "repo");
    expect(artifacts.map((a) => a.path)).toEqual([
      join(root, "CLAUDE.md"),
      join(root, ".claude/settings.json"),
      join(root, ".mcp.json"),
    ]);
  });

  it("CLAUDE.md imports sources instead of copying them, with a valid header", async () => {
    const { byPath } = await emitScope(root, home, "repo");
    const content = byPath[join(root, "CLAUDE.md")]?.content ?? "";
    const parsed = parseHeader(content);
    expect(parsed?.body).toBe(
      "@.agents/AGENTS.md\n\n@.agents/memory/a-domain.md\n@.agents/memory/b-stack.md\n",
    );
    expect(parsed?.hash).toBe(shortHash(parsed?.body ?? ""));
    expect(content).not.toContain("Run `npm test`");
  });

  it("settings.json only carries owned permission keys", async () => {
    const { byPath } = await emitScope(root, home, "repo");
    const settings = byPath[join(root, ".claude/settings.json")];
    expect(settings?.strategy).toEqual({
      mergeKeys: [
        "permissions.allow",
        "permissions.ask",
        "permissions.deny",
        "permissions.defaultMode",
      ],
    });
    expect(JSON.parse(settings?.content ?? "")).toEqual({
      permissions: { allow: ["Bash(npm run test*)", "Edit(/src/**)"] },
    });
  });

  it(".mcp.json translates ${env:VAR} without resolving it", async () => {
    process.env.GITHUB_TOKEN = "must-not-leak";
    const { byPath } = await emitScope(root, home, "repo");
    const content = byPath[join(root, ".mcp.json")]?.content ?? "";
    expect(content).not.toContain("must-not-leak");
    expect(JSON.parse(content)).toEqual({
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
        },
      },
    });
  });
});

describe("claude emit: other scopes", () => {
  it("local scope writes CLAUDE.local.md importing .agents/local", async () => {
    const { artifacts } = await emitScope(root, home, "local");
    expect(artifacts.map((a) => a.path)).toEqual([join(root, "CLAUDE.local.md")]);
    expect(parseHeader(artifacts[0]?.content ?? "")?.body).toBe("@.agents/local/AGENTS.md\n");
  });

  it("global scope imports through ~/ and writes ~/.claude/settings.json", async () => {
    const { byPath } = await emitScope(root, home, "global");
    expect(parseHeader(byPath[join(home, ".claude/CLAUDE.md")]?.content ?? "")?.body).toBe(
      "@~/.agents/AGENTS.md\n\n@~/.agents/memory/style.md\n",
    );
    expect(JSON.parse(byPath[join(home, ".claude/settings.json")]?.content ?? "")).toEqual({
      permissions: { deny: ["Read(.env*)"], defaultMode: "default" },
    });
  });

  it("an empty layer emits nothing", async () => {
    const empty = await writeTree({});
    const { artifacts } = await emitScope(empty, empty, "local");
    expect(artifacts).toEqual([]);
  });
});

describe("claude emit: policy edge cases", () => {
  async function emitPolicy(policy: string, scope: Scope = "repo") {
    const dir = scope === "local" ? ".agents/local" : ".agents";
    const r = await writeTree({ [`${dir}/policy.md`]: policy });
    const out = await emitScope(r, await writeTree({}), scope);
    const settings = out.artifacts.find(
      (a) => a.path.endsWith(".json") && a.path.includes("settings"),
    );
    return {
      settings: settings ? JSON.parse(settings.content) : undefined,
      warnings: claude.lossy(out.ir, out.ctx).map((w) => w.code),
      paths: out.artifacts.map((a) => a.path.slice(r.length + 1)),
    };
  }

  it.each([
    ["deny", "dontAsk"],
    ["ask", "default"],
  ])("explicit default %s -> defaultMode %s", async (level, mode) => {
    const { settings } = await emitPolicy(`---\npermissions:\n  default: ${level}\n---\n`);
    expect(settings).toEqual({ permissions: { defaultMode: mode } });
  });

  it("default allow never becomes bypassPermissions", async () => {
    const { settings, warnings } = await emitPolicy("---\npermissions:\n  default: allow\n---\n");
    expect(settings).toEqual({ permissions: { defaultMode: "default" } });
    expect(warnings).toContain("claude-default-allow");
  });

  it("raw overrides are appended verbatim and may set defaultMode", async () => {
    const { settings } = await emitPolicy(
      [
        "---",
        "permissions:",
        "  allow: [{ shell: 'ls*' }]",
        "overrides:",
        "  claude:",
        "    permissions:",
        "      allow: ['WebFetch(domain:docs.example.com)', 'Bash(ls*)']",
        "      defaultMode: auto",
        "---",
        "",
      ].join("\n"),
    );
    expect(settings).toEqual({
      permissions: {
        allow: ["Bash(ls*)", "WebFetch(domain:docs.example.com)"],
        defaultMode: "auto",
      },
    });
  });

  it("local MCP servers are skipped with a warning", async () => {
    const { paths, warnings } = await emitPolicy("---\nmcp:\n  x:\n    command: x\n---\n", "local");
    expect(paths).toEqual([]);
    expect(warnings).toContain("claude-mcp-scope-unsupported");
  });

  it("an import path with whitespace is inlined", async () => {
    const r = await writeTree({ ".agents/memory/my notes.md": "remember this\n" });
    const { artifacts, ir, ctx } = await emitScope(r, await writeTree({}), "repo");
    expect(parseHeader(artifacts[0]?.content ?? "")?.body).toBe("remember this\n");
    expect(claude.lossy(ir, ctx).map((w) => w.code)).toEqual(["claude-import-inlined"]);
  });
});
