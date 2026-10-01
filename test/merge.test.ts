import { describe, expect, it } from "vitest";
import { mergeLayers } from "../src/ir/merge.ts";
import type { Layer } from "../src/ir/parse.ts";
import type { Capability, Ir, Policy, Scope } from "../src/ir/schema.ts";

/** Builds a layer from just a policy, the common case in these tables. */
function layer(scope: Scope, policy: Policy, extra: Partial<Layer> = {}): Layer {
  return {
    scope,
    dir: `/${scope}/.agents`,
    exists: true,
    instructions: [],
    memory: [],
    policy,
    warnings: [],
    ...extra,
  };
}

const sh = (shell: string): Capability => ({ shell });
const read = (glob: string): Capability => ({ "fs.read": glob });
const net = (network: "none" | "restricted" | "full"): Capability => ({ network });

type Perms = Pick<Ir["permissions"], "allow" | "ask" | "deny">;
const perms = (p: Partial<Perms>): Perms => ({ allow: [], ask: [], deny: [], ...p });

describe("mergeLayers: permission lists", () => {
  const cases: { name: string; layers: Layer[]; expected: Perms; warnings?: string[] }[] = [
    {
      name: "lists concatenate in scope order",
      layers: [
        layer("global", { permissions: { allow: [sh("ls*")] } }),
        layer("repo", { permissions: { allow: [sh("npm test*")] } }),
        layer("local", { permissions: { allow: [sh("make*")] } }),
      ],
      expected: perms({ allow: [sh("ls*"), sh("npm test*"), sh("make*")] }),
    },
    {
      name: "duplicates across scopes are deduped, first occurrence kept",
      layers: [
        layer("global", { permissions: { allow: [sh("ls*"), read("src/**")] } }),
        layer("repo", { permissions: { allow: [read("src/**"), sh("ls*")] } }),
      ],
      expected: perms({ allow: [sh("ls*"), read("src/**")] }),
    },
    {
      name: "duplicates within one list are deduped",
      layers: [layer("repo", { permissions: { deny: [read(".env*"), read(".env*")] } })],
      expected: perms({ deny: [read(".env*")] }),
    },
    {
      name: "global deny beats repo allow",
      layers: [
        layer("global", { permissions: { deny: [read(".env*")] } }),
        layer("repo", { permissions: { allow: [read(".env*")] } }),
      ],
      expected: perms({ deny: [read(".env*")] }),
      warnings: ["shadowed-by-deny"],
    },
    {
      name: "local deny beats global allow (narrow deny also wins)",
      layers: [
        layer("global", { permissions: { allow: [sh("git push*")] } }),
        layer("local", { permissions: { deny: [sh("git push*")] } }),
      ],
      expected: perms({ deny: [sh("git push*")] }),
      warnings: ["shadowed-by-deny"],
    },
    {
      name: "deny beats ask",
      layers: [
        layer("global", { permissions: { ask: [sh("rm*")] } }),
        layer("repo", { permissions: { deny: [sh("rm*")] } }),
      ],
      expected: perms({ deny: [sh("rm*")] }),
      warnings: ["shadowed-by-deny"],
    },
    {
      name: "ask beats allow at any scope",
      layers: [
        layer("global", { permissions: { ask: [sh("git push*")] } }),
        layer("local", { permissions: { allow: [sh("git push*")] } }),
      ],
      expected: perms({ ask: [sh("git push*")] }),
      warnings: ["shadowed-by-ask"],
    },
    {
      name: "same capability in all three lists of one layer resolves to deny",
      layers: [
        layer("repo", { permissions: { allow: [sh("x")], ask: [sh("x")], deny: [sh("x")] } }),
      ],
      expected: perms({ deny: [sh("x")] }),
      warnings: ["shadowed-by-deny", "shadowed-by-deny"],
    },
    {
      name: "overlapping but different globs are both kept (target evaluates deny first)",
      layers: [
        layer("global", { permissions: { deny: [read(".env*")] } }),
        layer("repo", { permissions: { allow: [read(".env.example")] } }),
      ],
      expected: perms({ allow: [read(".env.example")], deny: [read(".env*")] }),
    },
    {
      name: "capability equality ignores key order of the source object",
      layers: [
        layer("global", { permissions: { deny: [{ mcp: "gh.*" }] } }),
        layer("repo", { permissions: { allow: [{ mcp: "gh.*" }] } }),
      ],
      expected: perms({ deny: [{ mcp: "gh.*" }] }),
      warnings: ["shadowed-by-deny"],
    },
  ];

  it.each(cases)("$name", ({ layers, expected, warnings = [] }) => {
    const { ir, warnings: got } = mergeLayers(layers);
    const { allow, ask, deny } = ir.permissions;
    expect({ allow, ask, deny }).toEqual(expected);
    expect(got.map((w) => w.code)).toEqual(warnings);
  });
});

describe("mergeLayers: network (scalar inside the lists)", () => {
  const cases: { name: string; layers: Layer[]; expected: Perms; warnings?: string[] }[] = [
    {
      name: "narrower scope overrides a wider allow",
      layers: [
        layer("global", { permissions: { allow: [net("full")] } }),
        layer("repo", { permissions: { allow: [net("restricted")] } }),
      ],
      expected: perms({ allow: [net("restricted")] }),
    },
    {
      name: "narrower scope may also widen a non-deny setting",
      layers: [
        layer("global", { permissions: { ask: [net("restricted")] } }),
        layer("local", { permissions: { allow: [net("full")] } }),
      ],
      expected: perms({ allow: [net("full")] }),
    },
    {
      name: "a deny at a wider scope locks the setting",
      layers: [
        layer("global", { permissions: { deny: [net("none")] } }),
        layer("repo", { permissions: { allow: [net("full")] } }),
      ],
      expected: perms({ deny: [net("none")] }),
      warnings: ["network-locked-by-deny"],
    },
    {
      name: "several denies: the most restrictive level wins, not the narrowest",
      layers: [
        layer("global", { permissions: { deny: [net("none")] } }),
        layer("repo", { permissions: { deny: [net("restricted")] } }),
      ],
      expected: perms({ deny: [net("none")] }),
      warnings: ["network-locked-by-deny"],
    },
    {
      name: "same scope: ask beats allow",
      layers: [layer("repo", { permissions: { allow: [net("full")], ask: [net("restricted")] } })],
      expected: perms({ ask: [net("restricted")] }),
    },
    {
      name: "network keeps its position among other capabilities",
      layers: [layer("repo", { permissions: { deny: [read(".env*"), net("none"), sh("curl*")] } })],
      expected: perms({ deny: [read(".env*"), net("none"), sh("curl*")] }),
    },
  ];

  it.each(cases)("$name", ({ layers, expected, warnings = [] }) => {
    const { ir, warnings: got } = mergeLayers(layers);
    const { allow, ask, deny } = ir.permissions;
    expect({ allow, ask, deny }).toEqual(expected);
    expect(got.map((w) => w.code)).toEqual(warnings);
  });
});

describe("mergeLayers: scalars, mcp, overrides", () => {
  it("default: narrower scope wins, falls back to ask", () => {
    expect(mergeLayers([]).ir.permissions.default).toBe("ask");
    const { ir } = mergeLayers([
      layer("global", { permissions: { default: "deny" } }),
      layer("repo", { permissions: { default: "allow" } }),
      layer("local", {}),
    ]);
    expect(ir.permissions.default).toBe("allow");
  });

  it("mcp: same-name server is replaced whole by the narrower scope, keys sorted", () => {
    const { ir } = mergeLayers([
      layer("global", {
        mcp: { zeta: { command: "z" }, gh: { command: "old", args: ["a"], env: { A: "1" } } },
      }),
      layer("repo", { mcp: { gh: { command: "new" }, alpha: { command: "a" } } }),
    ]);
    expect(ir.mcp).toEqual({
      alpha: { command: "a" },
      gh: { command: "new" },
      zeta: { command: "z" },
    });
    expect(Object.keys(ir.mcp)).toEqual(["alpha", "gh", "zeta"]);
  });

  it("overrides: deep merge, narrower scalar wins, arrays concat + dedupe", () => {
    const { ir } = mergeLayers([
      layer("global", {
        overrides: { claude: { permissions: { defaultMode: "auto", allow: ["Skill(x)"] }, a: 1 } },
      }),
      layer("repo", {
        overrides: {
          claude: { permissions: { defaultMode: "plan", allow: ["Skill(x)", "Skill(y)"] } },
          codex: { model: "o5" },
        },
      }),
    ]);
    expect(ir.overrides).toEqual({
      claude: { permissions: { defaultMode: "plan", allow: ["Skill(x)", "Skill(y)"] }, a: 1 },
      codex: { model: "o5" },
    });
  });

  it("overrides: type mismatch, narrower value replaces", () => {
    const { ir } = mergeLayers([
      layer("global", { overrides: { claude: { k: { nested: true } } } }),
      layer("repo", { overrides: { claude: { k: ["list"] } } }),
    ]);
    expect(ir.overrides).toEqual({ claude: { k: ["list"] } });
  });
});

describe("mergeLayers: instructions and memory", () => {
  it("concatenates in scope order regardless of input order, keeping source tags", () => {
    const { ir } = mergeLayers([
      layer("local", {}, { instructions: [{ source: "/l", scope: "local", body: "L" }] }),
      layer("global", {}, { instructions: [{ source: "/g", scope: "global", body: "G" }] }),
      layer("repo", {}, { instructions: [{ source: "/r", scope: "repo", body: "R" }] }),
    ]);
    expect(ir.instructions.map((i) => [i.source, i.body])).toEqual([
      ["/g", "G"],
      ["/r", "R"],
      ["/l", "L"],
    ]);
  });

  it("keeps same-topic memory from different scopes as separate blocks", () => {
    const { ir } = mergeLayers([
      layer("global", {}, { memory: [{ topic: "style", scope: "global", body: "g" }] }),
      layer("repo", {}, { memory: [{ topic: "style", scope: "repo", body: "r" }] }),
    ]);
    expect(ir.memory).toEqual([
      { topic: "style", scope: "global", body: "g" },
      { topic: "style", scope: "repo", body: "r" },
    ]);
  });

  it("forwards layer warnings", () => {
    const { warnings } = mergeLayers([
      layer("repo", {}, { warnings: [{ code: "policy-body-ignored", message: "m" }] }),
    ]);
    expect(warnings.map((w) => w.code)).toEqual(["policy-body-ignored"]);
  });
});

describe("mergeLayers: determinism", () => {
  it("produces a schema-valid IR identical across runs", () => {
    const layers = [
      layer("global", {
        permissions: { deny: [net("none"), read(".env*")] },
        mcp: { b: { command: "b" } },
      }),
      layer("repo", {
        permissions: { allow: [sh("npm*"), net("full")] },
        mcp: { a: { command: "a" } },
      }),
    ];
    const first = mergeLayers(layers).ir;
    expect(mergeLayers(layers).ir).toEqual(first);
    expect(JSON.stringify(mergeLayers(layers).ir)).toBe(JSON.stringify(first));
  });
});
