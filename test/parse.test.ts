import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceError } from "../src/ir/diagnostics.ts";
import { parseLayer, parseLayers, parsePolicy } from "../src/ir/parse.ts";
import { FIXTURES, writeTree } from "./helpers.ts";

describe("parseLayers (fixture: basic)", () => {
  const root = join(FIXTURES, "basic/repo");
  const home = join(FIXTURES, "basic/home");

  it("reads the three layers in scope order", async () => {
    const layers = await parseLayers(root, home);
    expect(layers.map((l) => [l.scope, l.exists])).toEqual([
      ["global", true],
      ["repo", true],
      ["local", true],
    ]);
  });

  it("tags instructions with their absolute source and scope", async () => {
    const [global, repo, local] = await parseLayers(root, home);
    expect(global?.instructions).toEqual([
      {
        source: join(home, ".agents/AGENTS.md"),
        scope: "global",
        body: "# Global\n\nReply in Italian.\n",
      },
    ]);
    expect(repo?.instructions[0]?.source).toBe(join(root, ".agents/AGENTS.md"));
    expect(local?.instructions[0]?.scope).toBe("local");
  });

  it("sorts memory by file name and uses the basename as topic", async () => {
    const [, repo] = await parseLayers(root, home);
    expect(repo?.memory.map((m) => m.topic)).toEqual(["a-domain", "b-stack"]);
  });

  it("keeps ${env:VAR} references unresolved", async () => {
    const [, repo] = await parseLayers(root, home);
    expect(repo?.policy.mcp?.github?.env).toEqual({ GITHUB_TOKEN: "${env:GITHUB_TOKEN}" });
  });

  it("does not read the local layer as repo memory or instructions", async () => {
    const [, repo] = await parseLayers(root, home);
    expect(repo?.instructions).toHaveLength(1);
    expect(repo?.memory).toHaveLength(2);
  });
});

describe("parseLayer edge cases", () => {
  it("returns an empty layer for a missing directory", async () => {
    const layer = await parseLayer("/nonexistent/.agents", "repo");
    expect(layer).toMatchObject({ exists: false, instructions: [], memory: [], policy: {} });
  });

  it("returns an empty layer for an empty directory", async () => {
    const root = await writeTree({});
    await mkdir(join(root, ".agents"));
    const layer = await parseLayer(join(root, ".agents"), "repo");
    expect(layer).toMatchObject({ exists: true, instructions: [], memory: [], policy: {} });
  });

  it("strips BOM and normalizes CRLF", async () => {
    const root = await writeTree({ ".agents/AGENTS.md": "﻿a\r\nb\rc\n" });
    const layer = await parseLayer(join(root, ".agents"), "repo");
    expect(layer.instructions[0]?.body).toBe("a\nb\nc\n");
  });

  it("ignores non-md, dotfiles and directories in memory/", async () => {
    const root = await writeTree({
      ".agents/memory/topic.md": "x",
      ".agents/memory/.hidden.md": "x",
      ".agents/memory/notes.txt": "x",
      ".agents/memory/nested.md/inner.md": "x",
    });
    const layer = await parseLayer(join(root, ".agents"), "repo");
    expect(layer.memory.map((m) => m.topic)).toEqual(["topic"]);
  });

  it("follows a symlinked .agents directory", async () => {
    const real = await writeTree({ "AGENTS.md": "linked" });
    const root = await writeTree({});
    await symlink(real, join(root, ".agents"));
    const layer = await parseLayer(join(root, ".agents"), "repo");
    expect(layer.instructions[0]?.body).toBe("linked");
  });

  it("reads the home layer once when run from $HOME", async () => {
    const home = await writeTree({ ".agents/AGENTS.md": "global" });
    const layers = await parseLayers(home, home);
    expect(layers.flatMap((l) => l.instructions.map((i) => i.body))).toEqual(["global"]);
    expect(layers[1]?.warnings[0]?.code).toBe("repo-is-global");
  });

  it("collects schema issues from every layer", async () => {
    const home = await writeTree({ ".agents/policy.md": "---\nbogus: 1\n---\n" });
    const root = await writeTree({
      ".agents/policy.md": "---\npermissions:\n  default: maybe\n---\n",
    });
    const error = await parseLayers(root, home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).issues.map((i) => i.path)).toEqual([
      join(home, ".agents/policy.md"),
      join(root, ".agents/policy.md"),
    ]);
  });
});

describe("parsePolicy", () => {
  const cases: [string, string, object][] = [
    ["empty file", "", {}],
    ["empty frontmatter", "---\n---\n", {}],
    ["null frontmatter", "---\n~\n---\n", {}],
    [
      "permissions",
      "---\npermissions:\n  default: deny\n---\n",
      { permissions: { default: "deny" } },
    ],
  ];
  it.each(cases)("parses %s", (_name, text, expected) => {
    expect(parsePolicy("p.md", text)).toEqual({ policy: expected, warnings: [] });
  });

  it("warns when the body is not empty", () => {
    const { warnings } = parsePolicy("p.md", "---\n---\nsome prose\n");
    expect(warnings.map((w) => w.code)).toEqual(["policy-body-ignored"]);
  });

  it("refuses executable frontmatter engines", () => {
    globalThis.__tenorePwned = false;
    const text = "---js\n{ x: (globalThis.__tenorePwned = true) }\n---\n";
    expect(() => parsePolicy("p.md", text)).toThrow(SourceError);
    expect(globalThis.__tenorePwned).toBe(false);
  });

  it("refuses explicit non-YAML language even with spacing", () => {
    expect(() => parsePolicy("p.md", "--- javascript\n{}\n---\n")).toThrow(/only YAML/);
  });

  it("reports invalid YAML as a SourceError, not a crash", () => {
    expect(() => parsePolicy("p.md", "---\npermissions: [\n---\n")).toThrow(SourceError);
  });

  it("rejects YAML types outside the schema (dates, numbers)", () => {
    expect(() => parsePolicy("p.md", "---\npermissions:\n  default: 2024-01-01\n---\n")).toThrow(
      SourceError,
    );
  });
});

declare global {
  var __tenorePwned: boolean | undefined;
}
