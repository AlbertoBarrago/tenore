import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { parseBlocks, renderBlocks } from "../src/adapters/codex/instructions.ts";
import {
  globToPrefix,
  parseRules,
  renderRules,
  toPrefixRules,
} from "../src/adapters/codex/rules.ts";
import { codex } from "../src/adapters/codex.ts";
import type { ImportResult } from "../src/adapters/types.ts";
import { canonicalKey } from "../src/ir/canonical.ts";
import { parseLayers } from "../src/ir/parse.ts";
import type { Capability, PermissionLevel, Policy, Scope } from "../src/ir/schema.ts";
import { compile } from "../src/sync/compile.ts";
import { parseHeader } from "../src/sync/hash.ts";
import { applyPlan, planSync } from "../src/sync/plan.ts";
import { writeTree } from "./helpers.ts";

/** The real CLI is optional: CI machines usually do not have it. */
const hasCodex = (() => {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const lists = (p: Partial<Record<PermissionLevel, Capability[]>>) => ({
  allow: [],
  ask: [],
  deny: [],
  ...p,
});

describe("codex rules: glob -> prefix", () => {
  it.each([
    ["git push", ["git", "push"], true],
    ["git push *", ["git", "push"], true],
    ["npm run test*", ["npm", "run"], false],
    ["git * --force", ["git"], false],
    ["*", [], false],
  ])("%s", (glob, pattern, exact) => {
    expect(globToPrefix(glob)).toEqual({ pattern, exact });
  });

  it("deny -> forbidden, ask -> prompt, allow is never emitted", () => {
    const out = toPrefixRules(
      lists({
        deny: [{ shell: "rm -rf *" }, { shell: "npm run test*" }],
        ask: [{ shell: "git push *" }],
        allow: [{ shell: "ls *" }],
      }),
    );
    expect(out.rules).toEqual([
      { pattern: ["rm", "-rf"], decision: "forbidden" },
      { pattern: ["npm", "run"], decision: "forbidden" },
      { pattern: ["git", "push"], decision: "prompt" },
    ]);
    expect(out.warnings.map((w) => w.code)).toEqual([
      "codex-shell-broadened",
      "codex-shell-allow-sandboxed",
    ]);
  });

  it("a leading wildcard deny is flagged as not enforced", () => {
    const out = toPrefixRules(lists({ deny: [{ shell: "* --force" }] }));
    expect(out.rules).toEqual([]);
    expect(out.warnings[0]?.message).toContain("NOT ENFORCED");
  });

  it("render/parse round-trips, unknown lines are kept verbatim", () => {
    const rules = [{ pattern: ["echo", 'a "b" \\ c'], decision: "forbidden" as const }];
    const text = `${renderRules(rules)}prefix_rule(pattern = ["gh", ["pr", "issue"]], decision = "prompt")\n`;
    expect(parseRules(text)).toEqual({
      rules,
      rest: 'prefix_rule(pattern = ["gh", ["pr", "issue"]], decision = "prompt")\n',
    });
  });
});

describe("codex instructions blocks", () => {
  it("render/parse round-trips and keeps hand-added text as loose", () => {
    const body = renderBlocks(
      [
        {
          block: { source: "/r/.agents/AGENTS.md", scope: "repo", body: "rules\n" },
          ref: ".agents/AGENTS.md",
        },
      ],
      [{ topic: "stack", scope: "repo", body: "ts\n" }],
    );
    const parsed = parseBlocks(`${body}\nadded by hand\n`);
    expect(parsed).toEqual({
      instructions: [{ scope: "repo", ref: ".agents/AGENTS.md", body: "rules\n" }],
      memory: [{ topic: "stack", scope: "repo", body: "ts\n" }],
      loose: "added by hand\n",
    });
  });

  it("an unterminated block is kept as loose text", () => {
    const parsed = parseBlocks("<!-- tenore:begin memory repo x -->\nkeep me\n");
    expect(parsed.memory).toEqual([]);
    expect(parsed.loose).toBe("keep me\n");
  });
});

async function emitScope(root: string, home: string, scope: Scope) {
  const layers = await parseLayers(root, home);
  const { compiled } = await compile(codex, layers, [scope], root, home);
  const c = compiled[0];
  return {
    byName: Object.fromEntries(
      (c?.artifacts ?? []).map((a) => [
        a.path.slice((scope === "global" ? home : root).length + 1),
        a,
      ]),
    ),
    warnings: (c?.warnings ?? []).map((w) => w.code),
  };
}

const POLICY = [
  "---",
  "permissions:",
  "  default: deny",
  "  deny: [{ shell: 'rm -rf *' }, { network: none }, { mcp: 'gh.delete_repo' }, { fs.read: '.env*' }]",
  "  ask: [{ shell: 'git push *' }, { mcp: 'gh.*' }]",
  "  allow: [{ mcp: 'gh.list_issues' }]",
  "mcp:",
  "  gh:",
  "    command: npx",
  "    args: ['-y', 'gh-mcp']",
  "    env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}', LOG: debug }",
  "---",
  "",
].join("\n");

describe("codex emit", () => {
  it("repo scope: AGENTS.md copies sources, config.toml and rules", async () => {
    const root = await writeTree({
      ".agents/AGENTS.md": "rules\n",
      ".agents/memory/stack.md": "ts\n",
      ".agents/policy.md": POLICY,
    });
    const { byName, warnings } = await emitScope(root, await writeTree({}), "repo");
    expect(Object.keys(byName)).toEqual([
      "AGENTS.md",
      ".codex/config.toml",
      ".codex/rules/tenore.rules",
    ]);

    const md = parseHeader(byName["AGENTS.md"]?.content ?? "");
    expect(md?.body).toBe(
      "<!-- tenore:begin instructions repo .agents/AGENTS.md -->\nrules\n<!-- tenore:end -->\n\n" +
        "<!-- tenore:begin memory repo stack -->\nts\n<!-- tenore:end -->\n",
    );

    expect(parseToml(byName[".codex/config.toml"]?.content ?? "")).toEqual({
      approval_policy: "never",
      web_search: "disabled",
      sandbox_workspace_write: { network_access: false },
      mcp_servers: {
        gh: {
          command: "npx",
          args: ["-y", "gh-mcp"],
          env: { LOG: "debug" },
          env_vars: ["GITHUB_TOKEN"],
          disabled_tools: ["delete_repo"],
          default_tools_approval_mode: "prompt",
          tools: { list_issues: { approval_mode: "approve" } },
        },
      },
    });

    expect(parseHeader(byName[".codex/rules/tenore.rules"]?.content ?? "")?.body).toBe(
      'prefix_rule(pattern = ["rm", "-rf"], decision = "forbidden")\n' +
        'prefix_rule(pattern = ["git", "push"], decision = "prompt")\n',
    );
    expect(byName[".codex/rules/tenore.rules"]?.content).toMatch(/^# generated by tenore sync/);
    expect(warnings).toEqual(["codex-fs-unsupported", "codex-project-trust"]);
  });

  it("never resolves env, and skips servers it cannot express", async () => {
    process.env.GITHUB_TOKEN = "must-not-leak";
    const root = await writeTree({
      ".agents/policy.md":
        "---\nmcp:\n  a: { command: x, env: { TOKEN: '${env:GITHUB_TOKEN}' } }\n  b: { command: x, args: ['${env:B}'] }\n---\n",
    });
    const { byName, warnings } = await emitScope(root, await writeTree({}), "repo");
    expect(byName[".codex/config.toml"]).toBeUndefined();
    expect(warnings).toEqual(["codex-mcp-env-unsupported", "codex-mcp-env-unsupported"]);
  });

  it("local scope writes AGENTS.override.md with repo and local blocks, warns on local policy", async () => {
    const root = await writeTree({
      ".agents/AGENTS.md": "repo\n",
      ".agents/local/AGENTS.md": "local\n",
      ".agents/local/policy.md": "---\npermissions:\n  deny: [{ shell: 'make deploy' }]\n---\n",
    });
    const { byName, warnings } = await emitScope(root, await writeTree({}), "local");
    expect(Object.keys(byName)).toEqual(["AGENTS.override.md"]);
    const blocks = parseBlocks(
      parseHeader(byName["AGENTS.override.md"]?.content ?? "")?.body ?? "",
    );
    expect(blocks.instructions.map((b) => [b.scope, b.body])).toEqual([
      ["repo", "repo\n"],
      ["local", "local\n"],
    ]);
    expect(warnings).toEqual(["codex-local-policy-unsupported"]);
  });

  it("an mcp rule for a server declared elsewhere is flagged", async () => {
    const root = await writeTree({
      ".agents/policy.md": "---\npermissions:\n  deny: [{ mcp: 'other.*' }]\n---\n",
    });
    const { warnings } = await emitScope(root, await writeTree({}), "repo");
    expect(warnings).toEqual(["codex-mcp-policy-orphan"]);
  });
});

/** Order-insensitive view of a policy: Codex spreads one list over two files. */
function normalize(policy: Policy): unknown {
  const p = structuredClone(policy);
  for (const list of ["allow", "ask", "deny"] as const) {
    p.permissions?.[list]?.sort((a, b) => canonicalKey(a).localeCompare(canonicalKey(b)));
  }
  return JSON.parse(canonicalKey(p));
}

describe("codex round-trip: .agents -> sync -> import", () => {
  const sync = async (root: string, home: string, scopes: Scope[]) => {
    const p = await planSync([codex], await parseLayers(root, home), scopes, root, home);
    await applyPlan(p);
    return p;
  };

  it.each([
    ["full policy", POLICY.replace("fs.read: '.env*'", "shell: 'curl *'")],
    ["network restricted", "---\npermissions:\n  ask: [{ network: restricted }]\n---\n"],
    [
      "raw overrides survive",
      [
        "---",
        "overrides:",
        "  codex:",
        "    approval_policy: { granular: { rules: true } }",
        "    mcp_servers: { remote: { url: 'https://example.com/mcp' } }",
        "    rules: \"prefix_rule(pattern = ['gh', ['pr', 'issue']], decision = 'prompt')\\n\"",
        "---",
        "",
      ].join("\n"),
    ],
  ])("%s", async (_name, policy) => {
    const root = await writeTree({
      ".agents/AGENTS.md": "rules\n",
      ".agents/memory/m.md": "mem\n",
      ".agents/policy.md": policy,
    });
    const home = await writeTree({});
    await sync(root, home, ["repo"]);
    const [, layer] = await parseLayers(root, home);
    const imported: ImportResult = await codex.import(root, { scope: "repo", root, home });
    expect(imported.instructions).toEqual(layer?.instructions);
    expect(imported.memory).toEqual(layer?.memory);
    expect(normalize(imported.policy)).toEqual(normalize(layer?.policy ?? {}));
  });

  it.skipIf(!hasCodex)("generated rules are enforced by the real codex binary", async () => {
    const root = await writeTree({
      ".agents/policy.md":
        "---\npermissions:\n  deny: [{ shell: 'rm -rf *' }]\n  ask: [{ shell: 'git push *' }]\n---\n",
    });
    await sync(root, await writeTree({}), ["repo"]);
    const rules = join(root, ".codex/rules/tenore.rules");
    const check = (...cmd: string[]) =>
      JSON.parse(
        execFileSync("codex", ["execpolicy", "check", "--rules", rules, "--", ...cmd], {
          encoding: "utf8",
        }),
      );
    expect(check("rm", "-rf", "/").decision).toBe("forbidden");
    expect(check("git", "push", "origin", "main").decision).toBe("prompt");
    expect(check("git", "status").decision).toBeUndefined();
  });
});

describe("init --import codex keeps what Codex cannot express", () => {
  it("fs rules, broadened shell globs, allow rules and other adapters' overrides survive", async () => {
    const policy = [
      "---",
      "permissions:",
      "  allow: [{ shell: 'ls *' }]",
      "  deny: [{ fs.read: '.env*' }, { shell: 'npm run test*' }, { shell: 'rm -rf *' }]",
      "overrides:",
      "  claude: { permissions: { defaultMode: auto } }",
      "---",
      "",
    ].join("\n");
    const root = await writeTree({ ".agents/AGENTS.md": "rules\n", ".agents/policy.md": policy });
    const home = await writeTree({});
    await applyPlan(await planSync([codex], await parseLayers(root, home), ["repo"], root, home));

    const { mergePolicy } = await import("../src/init.ts");
    const [, layer] = await parseLayers(root, home);
    const imported = await codex.import(root, { scope: "repo", root, home });
    expect(mergePolicy(codex, layer, imported.policy, "repo")).toEqual({
      permissions: {
        allow: [{ shell: "ls *" }],
        deny: [{ "fs.read": ".env*" }, { shell: "npm run test*" }, { shell: "rm -rf *" }],
      },
      overrides: { claude: { permissions: { defaultMode: "auto" } } },
    });
  });

  it("a native edit (new forbidden rule) is pulled in", async () => {
    const root = await writeTree({
      ".agents/policy.md": "---\npermissions:\n  deny: [{ shell: 'rm -rf *' }]\n---\n",
    });
    const home = await writeTree({});
    await applyPlan(await planSync([codex], await parseLayers(root, home), ["repo"], root, home));
    const rulesPath = join(root, ".codex/rules/tenore.rules");
    const { readFile, writeFile } = await import("node:fs/promises");
    await writeFile(
      rulesPath,
      `${await readFile(rulesPath, "utf8")}prefix_rule(pattern = ["git", "push"], decision = "prompt")\n`,
    );

    const { mergePolicy } = await import("../src/init.ts");
    const [, layer] = await parseLayers(root, home);
    const imported = await codex.import(root, { scope: "repo", root, home });
    expect(mergePolicy(codex, layer, imported.policy, "repo").permissions).toEqual({
      ask: [{ shell: "git push *" }],
      deny: [{ shell: "rm -rf *" }],
    });
  });
});

describe("codex permission profiles (opt-in)", () => {
  const POLICY_PROFILES = [
    "---",
    "permissions:",
    "  allow: [{ fs.write: 'src/**' }, { fs.read: '/opt/data/**' }]",
    "  ask: [{ fs.write: 'docs/**' }]",
    "  deny: [{ fs.read: '.env*' }, { fs.write: 'locked/**' }, { network: none }]",
    "overrides:",
    "  codex: { permission_profiles: true }",
    "---",
    "",
  ].join("\n");

  it("emits a tenore profile and no sandbox_workspace_write", async () => {
    const root = await writeTree({ ".agents/policy.md": POLICY_PROFILES });
    const { byName, warnings } = await emitScope(root, await writeTree({}), "repo");
    const config = byName[".codex/config.toml"];
    expect(parseToml(config?.content ?? "")).toEqual({
      web_search: "disabled",
      default_permissions: "tenore",
      permissions: {
        tenore: {
          description: "Generated by tenore from .agents/policy.md",
          extends: ":workspace",
          filesystem: {
            "/opt/data/**": "read",
            ":workspace_roots": {
              "**/.env*": "deny",
              "docs/**": "read",
              "locked/**": "read",
              "src/**": "write",
            },
          },
          network: { enabled: false },
        },
      },
    });
    expect(config?.strategy).toMatchObject({
      mergeKeys: expect.arrayContaining(["default_permissions", "permissions.tenore"]),
    });
    expect(warnings).toContain("codex-profiles-beta");
    expect(warnings).toContain("codex-fs-ask-as-sandbox");
    expect(warnings).not.toContain("codex-fs-unsupported");
  });

  it("round-trips the exactly expressible rules", async () => {
    const policy = [
      "---",
      "permissions:",
      "  allow: [{ fs.write: 'src/**' }, { fs.read: '/opt/data/**' }]",
      "  deny: [{ fs.read: '.env*' }, { fs.write: 'locked/**' }, { network: none }]",
      "overrides:",
      "  codex: { permission_profiles: true }",
      "---",
      "",
    ].join("\n");
    const root = await writeTree({ ".agents/policy.md": policy });
    const home = await writeTree({});
    await applyPlan(await planSync([codex], await parseLayers(root, home), ["repo"], root, home));
    const [, layer] = await parseLayers(root, home);
    const imported = await codex.import(root, { scope: "repo", root, home });
    expect(normalize(imported.policy)).toEqual(normalize(layer?.policy ?? {}));
  });

  it.skipIf(!hasCodex || process.platform !== "darwin")(
    "is enforced by the real codex sandbox",
    async () => {
      const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const home = await writeTree({ ".agents/policy.md": POLICY_PROFILES });
      const root = await mkdtemp(join(tmpdir(), "tenore-sandbox-"));
      await applyPlan(
        await planSync([codex], await parseLayers(root, home), ["global"], root, home),
      );
      await writeFile(join(root, ".env.local"), "secret\n");
      await writeFile(join(root, "ok.txt"), "ok\n");
      await mkdir(join(root, "locked"));
      const run = (script: string) => {
        try {
          execFileSync("codex", ["sandbox", "--", "sh", "-c", script], {
            cwd: root,
            env: { ...process.env, CODEX_HOME: join(home, ".codex") },
            stdio: "pipe",
          });
          return true;
        } catch {
          return false;
        }
      };
      expect(run("cat ok.txt")).toBe(true);
      expect(run("cat .env.local")).toBe(false);
      expect(run("echo x > locked/x")).toBe(false);
      expect(run("echo y > new.txt")).toBe(true);
    },
  );
});
