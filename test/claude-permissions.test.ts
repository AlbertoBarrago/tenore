import { describe, expect, it } from "vitest";
import {
  fromClaudePath,
  fromClaudeRule,
  toClaudePath,
  toClaudeRules,
} from "../src/adapters/claude/permissions.ts";
import type { Capability, PermissionLevel, Scope } from "../src/ir/schema.ts";

const lists = (p: Partial<Record<PermissionLevel, Capability[]>>) => ({
  allow: [],
  ask: [],
  deny: [],
  ...p,
});

describe("toClaudeRules", () => {
  const cases: {
    name: string;
    scope?: Scope;
    input: Partial<Record<PermissionLevel, Capability[]>>;
    rules: Partial<Record<PermissionLevel, string[]>>;
    warnings?: string[];
  }[] = [
    {
      name: "shell glob maps 1:1 (no legacy :* rewrite)",
      input: { allow: [{ shell: "npm run test*" }] },
      rules: { allow: ["Bash(npm run test*)"] },
    },
    {
      name: "shell * is the bare tool",
      input: { ask: [{ shell: "*" }] },
      rules: { ask: ["Bash"] },
    },
    {
      name: "fs.read unanchored stays bare (any depth)",
      input: { deny: [{ "fs.read": ".env*" }] },
      rules: { deny: ["Read(.env*)"] },
    },
    {
      name: "fs.write maps to Edit, anchored at project root",
      input: { allow: [{ "fs.write": "src/**" }] },
      rules: { allow: ["Edit(/src/**)"] },
    },
    {
      name: "absolute and home paths",
      input: { deny: [{ "fs.read": "/etc/**" }, { "fs.read": "~/.ssh/**" }] },
      rules: { deny: ["Read(//etc/**)", "Read(~/.ssh/**)"] },
    },
    {
      name: "trailing slash alone does not anchor",
      input: { deny: [{ "fs.write": "dist/" }] },
      rules: { deny: ["Edit(dist/)"] },
    },
    {
      name: "mcp tool and server wildcard",
      input: { allow: [{ mcp: "gh.create_pr" }, { mcp: "telemaco.*" }] },
      rules: { allow: ["mcp__gh__create_pr", "mcp__telemaco"] },
    },
    {
      name: "network none denies native web tools, warns about shell",
      input: { allow: [{ network: "none" }] },
      rules: { deny: ["WebFetch", "WebSearch"] },
      warnings: ["claude-network-shell-bypass"],
    },
    {
      name: "network restricted asks",
      input: { deny: [{ network: "restricted" }] },
      rules: { ask: ["WebFetch", "WebSearch"] },
      warnings: ["claude-network-shell-bypass"],
    },
    { name: "network full emits nothing", input: { allow: [{ network: "full" }] }, rules: {} },
    {
      name: "global anchored allow is dropped (never widen)",
      scope: "global",
      input: { allow: [{ "fs.write": "src/**" }] },
      rules: {},
      warnings: ["claude-global-anchored-path"],
    },
    {
      name: "global anchored deny becomes any-depth deny",
      scope: "global",
      input: { deny: [{ "fs.read": "secrets/**" }] },
      rules: { deny: ["Read(secrets/**)"] },
      warnings: ["claude-global-anchored-path"],
    },
    {
      name: "duplicate output rules are collapsed",
      input: { deny: [{ network: "none" }, { "fs.read": "x" }, { "fs.read": "x" }] },
      rules: { deny: ["WebFetch", "WebSearch", "Read(x)"] },
      warnings: ["claude-network-shell-bypass"],
    },
  ];

  it.each(cases)("$name", ({ scope = "repo", input, rules, warnings = [] }) => {
    const out = toClaudeRules(lists(input), scope);
    expect(out.rules).toEqual({ allow: [], ask: [], deny: [], ...rules });
    expect(out.warnings.map((w) => w.code)).toEqual(warnings);
  });
});

describe("fromClaudeRule", () => {
  const cases: [string, Capability | undefined][] = [
    ["Bash", { shell: "*" }],
    ["Bash(npm run test*)", { shell: "npm run test*" }],
    ["Bash(npm run test:*)", { shell: "npm run test *" }],
    ["Read(.env*)", { "fs.read": ".env*" }],
    ["Read(//etc/**)", { "fs.read": "/etc/**" }],
    ["Read(~/.ssh/**)", { "fs.read": "~/.ssh/**" }],
    ["Edit(/src/**)", { "fs.write": "src/**" }],
    ["mcp__gh", { mcp: "gh.*" }],
    ["mcp__gh__*", { mcp: "gh.*" }],
    ["mcp__gh__create_pr", { mcp: "gh.create_pr" }],
    ["mcp__my_server__do-it", { mcp: "my_server.do-it" }],
    // Not exactly representable: kept verbatim in overrides by the importer.
    ["Edit(src/**)", undefined],
    ["Read(./x)", undefined],
    ["Read(/.env)", undefined],
    ["Write(src/**)", undefined],
    ["WebFetch(domain:example.com)", undefined],
    ["WebFetch", undefined],
    ["Skill(deploy)", undefined],
    ["Bash()", undefined],
  ];
  it.each(cases)("%s", (rule, expected) => {
    expect(fromClaudeRule(rule)).toEqual(expected);
  });
});

describe("path round-trip", () => {
  it.each([".env*", "src/**", "/etc/**", "~/.ssh/**", "dist/", "a/b/*.ts"])("%s", (glob) => {
    const claude = toClaudePath(glob, "repo");
    expect(claude).toBeDefined();
    expect(fromClaudePath(claude as string)).toBe(glob);
  });
});
