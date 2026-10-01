import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fromAntigravityRule,
  globTokenToRegex,
  regexTokenToGlob,
  toAntigravityRules,
} from "../src/adapters/antigravity/permissions.ts";
import { antigravity } from "../src/adapters/antigravity.ts";
import { mergePolicy } from "../src/init.ts";
import { canonicalKey } from "../src/ir/canonical.ts";
import type { Warning } from "../src/ir/diagnostics.ts";
import { parseLayers } from "../src/ir/parse.ts";
import type { Capability, PermissionLevel, Policy, Scope } from "../src/ir/schema.ts";
import { compile } from "../src/sync/compile.ts";
import { parseHeader, withHeader } from "../src/sync/hash.ts";
import { applyPlan, planSync } from "../src/sync/plan.ts";
import { writeTree } from "./helpers.ts";

const HOME = "/home/u";
const lists = (p: Partial<Record<PermissionLevel, Capability[]>>) => ({
  allow: [],
  ask: [],
  deny: [],
  ...p,
});
const codes = (ws: Warning[]) => ws.map((w) => w.code);

describe("antigravity permissions", () => {
  const cases: {
    name: string;
    input: Partial<Record<PermissionLevel, Capability[]>>;
    rules: Partial<Record<PermissionLevel, string[]>>;
    warnings?: string[];
  }[] = [
    {
      name: "prefix glob",
      input: { deny: [{ shell: "git push *" }] },
      rules: { deny: ["command(git push)"] },
    },
    {
      name: "in-token glob is an exact token regex",
      input: { allow: [{ shell: "npm run test*" }] },
      rules: { allow: ["command(regex:npm run test.*)"] },
    },
    { name: "shell *", input: { ask: [{ shell: "*" }] }, rules: { ask: ["command(*)"] } },
    {
      name: "middle * broadens deny, drops allow",
      input: { deny: [{ shell: "git * --force" }], allow: [{ shell: "docker * ls" }] },
      rules: { deny: ["command(git)"] },
      warnings: ["antigravity-shell-broadened", "antigravity-shell-allow-dropped"],
    },
    {
      name: "exact command allow is dropped (prefix match is wider)",
      input: { allow: [{ shell: "npm test" }], deny: [{ shell: "rm -rf /" }] },
      rules: { deny: ["command(rm -rf /)"] },
      warnings: ["antigravity-shell-allow-dropped"],
    },
    {
      name: "fs paths",
      input: {
        allow: [{ "fs.write": "src/**" }],
        deny: [{ "fs.read": "/etc/**" }, { "fs.write": "~/.ssh/**" }, { "fs.read": ".env" }],
      },
      rules: {
        allow: ["write_file(src/)"],
        deny: ["read_file(/etc/)", `write_file(${HOME}/.ssh/)`, "read_file(.env)"],
      },
      warnings: ["antigravity-fs-root-only"],
    },
    {
      name: "fs globs are not expressible: deny NOT ENFORCED",
      input: { deny: [{ "fs.read": ".env*" }] },
      rules: {},
      warnings: ["antigravity-fs-unexpressible"],
    },
    {
      name: "network none / restricted",
      input: { allow: [{ network: "none" }] },
      rules: { deny: ["read_url(*)", "execute_url(*)"] },
    },
    {
      name: "mcp",
      input: { ask: [{ mcp: "gh.*" }], deny: [{ mcp: "gh.delete_repo" }] },
      rules: { ask: ["mcp(gh/*)"], deny: ["mcp(gh/delete_repo)"] },
    },
  ];

  it.each(cases)("$name", ({ input, rules, warnings = [] }) => {
    const out = toAntigravityRules(lists(input), HOME);
    expect(out.rules).toEqual({ allow: [], ask: [], deny: [], ...rules });
    expect(codes(out.warnings)).toEqual(warnings);
  });

  it.each(["test*", "v1.2?", "a+b(c)", "x\\y", "[ab]"])("token regex round-trip: %s", (token) => {
    if (token === "[ab]") {
      // Character classes are escaped as literals, so they come back as literal brackets.
      expect(regexTokenToGlob(globTokenToRegex(token))).toBe("[ab]");
      return;
    }
    expect(regexTokenToGlob(globTokenToRegex(token))).toBe(token);
  });

  it.each([
    ["command(git push)", { shell: "git push *" }],
    ["command(regex:npm run test.*)", { shell: "npm run test*" }],
    ["command(*)", { shell: "*" }],
    ["read_file(/etc/)", { "fs.read": "/etc/**" }],
    [`write_file(${HOME}/.ssh/)`, { "fs.write": "~/.ssh/**" }],
    ["read_file(*)", { "fs.read": "**" }],
    ["mcp(gh/*)", { mcp: "gh.*" }],
    ["unsandboxed(git push)", undefined],
    ["read_url(google.com)", undefined],
    ["command(regex:(a|b))", undefined],
    ["mcp(*)", undefined],
  ])("fromAntigravityRule %s", (rule, expected) => {
    expect(fromAntigravityRule(rule, HOME)).toEqual(expected);
  });
});

async function emitScope(root: string, home: string, scope: Scope) {
  const { compiled } = await compile(
    antigravity,
    await parseLayers(root, home),
    [scope],
    root,
    home,
  );
  const base = scope === "global" ? home : root;
  const c = compiled[0];
  return {
    byName: Object.fromEntries((c?.artifacts ?? []).map((a) => [a.path.slice(base.length + 1), a])),
    warnings: (c?.warnings ?? []).map((w) => w.code),
  };
}

describe("antigravity emit", () => {
  it("repo: no instructions artifact (native), memory rule with includes, mcp_config.json", async () => {
    const root = await writeTree({
      ".agents/AGENTS.md": "rules\n",
      ".agents/memory/stack.md": "ts\n",
      ".agents/policy.md":
        "---\nmcp:\n  lint: { command: eslint-mcp, env: { LOG: debug } }\n  gh: { command: x, env: { T: '${env:T}' } }\n  ---\n".replace(
          "  ---",
          "---",
        ),
    });
    const { byName, warnings } = await emitScope(root, await writeTree({}), "repo");
    expect(Object.keys(byName)).toEqual([
      ".agents/rules/tenore-memory.md",
      ".agents/mcp_config.json",
    ]);
    const rule = byName[".agents/rules/tenore-memory.md"]?.content ?? "";
    expect(rule).toMatch(
      /^---\n# generated by tenore sync · hash:[0-9a-f]{12} · edit \.agents\/ instead\ntrigger: always_on\n/,
    );
    expect(rule).toContain("\n---\n\n@[stack](../memory/stack.md)\n");
    expect(parseHeader(rule)).toBeDefined();
    expect(JSON.parse(byName[".agents/mcp_config.json"]?.content ?? "")).toEqual({
      mcpServers: { lint: { command: "eslint-mcp", env: { LOG: "debug" } } },
    });
    expect(warnings).toEqual(["antigravity-mcp-env-unsupported"]);
  });

  it("repo permissions are reported as not enforced", async () => {
    const root = await writeTree({
      ".agents/policy.md": "---\npermissions:\n  deny: [{ shell: 'rm -rf *' }]\n---\n",
    });
    const { byName, warnings } = await emitScope(root, await writeTree({}), "repo");
    expect(byName).toEqual({});
    expect(warnings).toEqual(["antigravity-project-permissions-unsupported"]);
  });

  it("warns when a Codex-generated root AGENTS.md duplicates the instructions", async () => {
    const root = await writeTree({
      ".agents/memory/m.md": "x\n",
      "AGENTS.md": withHeader("copy\n"),
    });
    const { warnings } = await emitScope(root, await writeTree({}), "repo");
    expect(warnings).toEqual(["antigravity-duplicate-instructions"]);
  });

  it("global: rule includes ~/.agents, settings carry owned keys only", async () => {
    const home = await writeTree({
      ".agents/AGENTS.md": "global\n",
      ".agents/policy.md":
        "---\npermissions:\n  default: ask\n  deny: [{ shell: 'rm -rf *' }, { network: none }]\n  ask: [{ mcp: 'gh.*' }]\n---\n",
    });
    const { byName } = await emitScope(await writeTree({}), home, "global");
    expect(Object.keys(byName)).toEqual([
      ".gemini/config/rules/tenore.md",
      ".gemini/antigravity-cli/settings.json",
    ]);
    expect(byName[".gemini/config/rules/tenore.md"]?.content).toContain(
      "@[instructions](~/.agents/AGENTS.md)",
    );
    expect(JSON.parse(byName[".gemini/antigravity-cli/settings.json"]?.content ?? "")).toEqual({
      permissions: {
        deny: ["command(rm -rf)", "read_url(*)", "execute_url(*)"],
        ask: ["mcp(gh/*)"],
      },
      toolPermission: "request-review",
    });
    expect(byName[".gemini/antigravity-cli/settings.json"]?.strategy).toEqual({
      mergeKeys: ["permissions.allow", "permissions.ask", "permissions.deny", "toolPermission"],
    });
  });

  it("local: rule includes the local layer", async () => {
    const root = await writeTree({ ".agents/local/AGENTS.md": "local\n" });
    const { byName } = await emitScope(root, await writeTree({}), "local");
    expect(byName[".agents/rules/tenore-local.md"]?.content).toContain(
      "@[instructions](../local/AGENTS.md)",
    );
  });
});

function normalize(policy: Policy): unknown {
  const p = structuredClone(policy);
  for (const list of ["allow", "ask", "deny"] as const) {
    p.permissions?.[list]?.sort((a, b) => canonicalKey(a).localeCompare(canonicalKey(b)));
  }
  return JSON.parse(canonicalKey(p));
}

describe("antigravity round-trip", () => {
  const sync = async (root: string, home: string, scopes: Scope[]) =>
    applyPlan(await planSync([antigravity], await parseLayers(root, home), scopes, root, home));

  it("global: .agents -> sync -> import equals the source (exactly expressible policy)", async () => {
    const policy = [
      "---",
      "permissions:",
      "  default: deny",
      "  allow: [{ shell: 'npm run test*' }, { fs.write: 'src/**' }, { mcp: 'lint.*' }]",
      "  ask: [{ shell: 'git push *' }, { network: restricted }]",
      "  deny: [{ fs.read: '/etc/**' }, { fs.write: '~/.ssh/**' }, { mcp: 'gh.delete_repo' }]",
      "mcp:",
      "  lint: { command: eslint-mcp, args: ['--stdio'] }",
      "overrides:",
      "  antigravity:",
      "    permissions: { allow: ['unsandboxed(git push)', 'read_url(google.com)'] }",
      "    mcpServers: { remote: { serverUrl: 'https://example.com/mcp' } }",
      "---",
      "",
    ].join("\n");
    const home = await writeTree({
      ".agents/AGENTS.md": "g\n",
      ".agents/memory/m.md": "mem\n",
      ".agents/policy.md": policy,
    });
    const root = await writeTree({});
    await sync(root, home, ["global"]);
    const [layer] = await parseLayers(root, home);
    const imported = await antigravity.import(root, { scope: "global", root, home });
    expect(imported.instructions).toEqual(layer?.instructions);
    expect(imported.memory).toEqual(layer?.memory);
    expect(normalize(imported.policy)).toEqual(normalize(layer?.policy ?? {}));
    expect(imported.warnings).toEqual([]);
  });

  it("repo: instructions are the native file, memory comes back through includes", async () => {
    const root = await writeTree({ ".agents/AGENTS.md": "rules\n", ".agents/memory/a.md": "a\n" });
    const home = await writeTree({});
    await sync(root, home, ["repo"]);
    const [, layer] = await parseLayers(root, home);
    const imported = await antigravity.import(root, { scope: "repo", root, home });
    expect(imported.instructions).toEqual(layer?.instructions);
    expect(imported.memory).toEqual(layer?.memory);
  });

  it("init --import keeps what Antigravity cannot express", async () => {
    const home = await writeTree({
      ".agents/policy.md":
        "---\npermissions:\n  allow: [{ shell: 'npm test' }]\n  deny: [{ fs.read: '.env*' }, { shell: 'git * --force' }]\n---\n",
    });
    const root = await writeTree({});
    await sync(root, home, ["global"]);
    const [layer] = await parseLayers(root, home);
    const imported = await antigravity.import(root, { scope: "global", root, home });
    expect(mergePolicy(antigravity, layer, imported.policy, "global")).toEqual({
      permissions: {
        allow: [{ shell: "npm test" }],
        deny: [{ "fs.read": ".env*" }, { shell: "git * --force" }],
      },
    });
  });

  it("imports hand-written GEMINI.md and flags it for removal", async () => {
    const root = await writeTree({ "GEMINI.md": "# legacy\n" });
    await writeFile(join(root, "AGENTS.md"), "hand written\n");
    const imported = await antigravity.import(root, {
      scope: "repo",
      root,
      home: await writeTree({}),
    });
    expect(imported.instructions.map((i) => i.body)).toEqual(["# legacy\n", "hand written\n"]);
    expect(codes(imported.warnings)).toEqual([
      "antigravity-import-native-file",
      "antigravity-import-native-file",
    ]);
  });
});
