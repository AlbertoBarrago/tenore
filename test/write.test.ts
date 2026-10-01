import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebaseImports } from "../src/ir/serialize.ts";
import { parseHeader, shortHash, withHeader } from "../src/sync/hash.ts";
import { applyMergeKeys, renderArtifact, writeArtifact } from "../src/sync/write.ts";
import { writeTree } from "./helpers.ts";

const KEYS = ["permissions.allow", "permissions.deny", "permissions.defaultMode"];

describe("applyMergeKeys", () => {
  const cases: { name: string; existing: object; owned: object; expected: object }[] = [
    {
      name: "sets owned paths and leaves the rest",
      existing: { model: "opus", permissions: { additionalDirectories: ["x"], allow: ["old"] } },
      owned: { permissions: { allow: ["new"] } },
      expected: { model: "opus", permissions: { additionalDirectories: ["x"], allow: ["new"] } },
    },
    {
      name: "deletes owned paths missing from owned content",
      existing: { permissions: { allow: ["a"], deny: ["b"], defaultMode: "auto" } },
      owned: { permissions: { deny: ["b"] } },
      expected: { permissions: { deny: ["b"] } },
    },
    {
      name: "removes a parent emptied by deletion",
      existing: { a: 1, permissions: { allow: ["x"] } },
      owned: {},
      expected: { a: 1 },
    },
    {
      name: "creates parents on an empty file",
      existing: {},
      owned: { permissions: { allow: ["x"] } },
      expected: { permissions: { allow: ["x"] } },
    },
    {
      name: "replaces a non-object parent",
      existing: { permissions: "broken" },
      owned: { permissions: { allow: ["x"] } },
      expected: { permissions: { allow: ["x"] } },
    },
  ];
  it.each(cases)("$name", ({ existing, owned, expected }) => {
    expect(
      applyMergeKeys(existing as Record<string, unknown>, owned as Record<string, unknown>, KEYS),
    ).toEqual(expected);
  });

  it("does not mutate its input", () => {
    const existing = { permissions: { allow: ["a"] } };
    applyMergeKeys(existing, {}, KEYS);
    expect(existing).toEqual({ permissions: { allow: ["a"] } });
  });
});

describe("renderArtifact / writeArtifact", () => {
  it("keeps the existing bytes when owned keys are unchanged", async () => {
    const dir = await writeTree({ "s.json": '{"permissions":{"allow":["x"]},  "model":"opus"}' });
    const path = join(dir, "s.json");
    const out = await renderArtifact({
      path,
      content: JSON.stringify({ permissions: { allow: ["x"] } }),
      strategy: { mergeKeys: KEYS },
    });
    expect(out).toBe('{"permissions":{"allow":["x"]},  "model":"opus"}');
  });

  it("writes atomically, preserves mode and leaves no temp file", async () => {
    const dir = await writeTree({ "f.md": "old" });
    const path = join(dir, "f.md");
    await chmod(path, 0o600);
    await writeArtifact({ path, content: "new", strategy: "owned" });
    expect(await readFile(path, "utf8")).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["f.md"]);
  });

  it("creates missing parent directories", async () => {
    const dir = await writeTree({});
    const path = join(dir, ".claude/settings.json");
    await writeArtifact({
      path,
      content: '{"permissions":{"allow":["x"]}}',
      strategy: { mergeKeys: KEYS },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ permissions: { allow: ["x"] } });
  });

  it("refuses to merge into invalid JSON instead of overwriting it", async () => {
    const dir = await writeTree({ "s.json": "{ broken" });
    const path = join(dir, "s.json");
    await expect(
      writeArtifact({ path, content: "{}", strategy: { mergeKeys: KEYS } }),
    ).rejects.toThrow(/invalid JSON/);
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });
});

describe("rebaseImports", () => {
  it("rewrites relative imports to existing files, skips code, mentions and absolute refs", async () => {
    const dir = await writeTree({ "repo/docs/guide.md": "g" });
    const from = join(dir, "repo");
    const to = join(dir, "repo/.agents");
    const body = [
      "See @docs/guide.md and @missing.md, mail me at a@b.com, ping @alice.",
      "Inline `@docs/guide.md` stays.",
      "```",
      "@docs/guide.md",
      "```",
      "@~/notes.md @/abs/x.md",
    ].join("\n");
    expect(rebaseImports(body, from, to)).toBe(
      [
        "See @../docs/guide.md and @missing.md, mail me at a@b.com, ping @alice.",
        "Inline `@docs/guide.md` stays.",
        "```",
        "@docs/guide.md",
        "```",
        "@~/notes.md @/abs/x.md",
      ].join("\n"),
    );
  });

  it("is the identity when the directory does not change", () => {
    expect(rebaseImports("@x.md", "/a", "/a")).toBe("@x.md");
  });
});

describe("TOML merge", () => {
  const TOML_KEYS = ["approval_policy", "mcp_servers"];

  it("merges owned keys into an existing config.toml, keeping the rest", async () => {
    const dir = await writeTree({ "config.toml": 'model = "gpt"\napproval_policy = "never"\n' });
    const out = await renderArtifact({
      path: join(dir, "config.toml"),
      content: 'approval_policy = "on-request"\n[mcp_servers.gh]\ncommand = "npx"\n',
      strategy: { mergeKeys: TOML_KEYS, format: "toml" },
    });
    expect(out).toBe(
      'model = "gpt"\napproval_policy = "on-request"\n\n[mcp_servers.gh]\ncommand = "npx"\n',
    );
  });

  it("keeps existing bytes (and comments) when owned keys are unchanged", async () => {
    const text = '# my config\nmodel = "gpt"  # inline\napproval_policy = "on-request"\n';
    const dir = await writeTree({ "config.toml": text });
    const out = await renderArtifact({
      path: join(dir, "config.toml"),
      content: 'approval_policy = "on-request"\n',
      strategy: { mergeKeys: TOML_KEYS, format: "toml" },
    });
    expect(out).toBe(text);
  });

  it("refuses to merge into invalid TOML", async () => {
    const dir = await writeTree({ "config.toml": "model = " });
    await expect(
      renderArtifact({
        path: join(dir, "config.toml"),
        content: "",
        strategy: { mergeKeys: TOML_KEYS, format: "toml" },
      }),
    ).rejects.toThrow(/invalid TOML/);
  });
});

describe("headers", () => {
  it.each(["html", "hash"] as const)("%s style round-trips", (style) => {
    const content = withHeader("body\n", style);
    expect(parseHeader(content)).toEqual({ hash: shortHash("body\n"), body: "body\n" });
  });
});
