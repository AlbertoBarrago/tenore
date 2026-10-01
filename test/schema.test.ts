import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyIr, IrSchema, PolicySchema, policyJsonSchema } from "../src/ir/schema.ts";

const valid: [string, unknown][] = [
  ["empty policy", {}],
  ["shell glob", { permissions: { allow: [{ shell: "npm run test*" }] } }],
  ["fs globs", { permissions: { deny: [{ "fs.read": ".env*" }, { "fs.write": "dist/**" }] } }],
  [
    "one network per list",
    { permissions: { deny: [{ network: "none" }], allow: [{ network: "full" }] } },
  ],
  [
    "mcp tool and wildcard",
    { permissions: { allow: [{ mcp: "gh.create_pr" }, { mcp: "telemaco.*" }] } },
  ],
  ["single underscore server", { mcp: { my_server: { command: "x" } } }],
  [
    "env reference",
    {
      mcp: {
        gh: { command: "npx", args: ["--token=${env:GH_TOKEN}"], env: { T: "${env:GH_TOKEN}" } },
      },
    },
  ],
  ["literal dollar", { mcp: { gh: { command: "echo", args: ["$HOME", "cost: 5$"] } } }],
  ["overrides", { overrides: { claude: { permissions: { defaultMode: "auto" } } } }],
  ["targets", { targets: ["claude", "antigravity"] }],
];

const invalid: [string, unknown][] = [
  ["unknown top-level key", { permision: {} }],
  ["unknown capability", { permissions: { allow: [{ exec: "ls" }] } }],
  ["two keys in one capability", { permissions: { allow: [{ shell: "ls", "fs.read": "x" }] } }],
  ["empty glob", { permissions: { allow: [{ shell: "" }] } }],
  [
    "two network in one list",
    { permissions: { deny: [{ network: "none" }, { network: "restricted" }] } },
  ],
  ["bad network level", { permissions: { deny: [{ network: "some" }] } }],
  ["mcp ref without tool", { permissions: { allow: [{ mcp: "gh" }] } }],
  ["server name with dot", { mcp: { "a.b": { command: "x" } } }],
  ["server name with double underscore", { mcp: { a__b: { command: "x" } } }],
  ["non-env placeholder", { mcp: { gh: { command: "x", env: { T: "${GH_TOKEN}" } } } }],
  ["lowercase env prefix typo", { mcp: { gh: { command: "x", env: { T: "${ENV:GH_TOKEN}" } } } }],
  ["unknown adapter override", { overrides: { cursor: {} } }],
  ["bad default", { permissions: { default: "maybe" } }],
];

describe("PolicySchema", () => {
  it.each(valid)("accepts: %s", (_name, input) => {
    expect(PolicySchema.safeParse(input).success).toBe(true);
  });
  it.each(invalid)("rejects: %s", (_name, input) => {
    expect(PolicySchema.safeParse(input).success).toBe(false);
  });
});

describe("IrSchema", () => {
  it("accepts the empty IR", () => {
    expect(IrSchema.parse(emptyIr())).toEqual(emptyIr());
  });
});

describe("policy.schema.json", () => {
  it("is up to date with the zod schema (run npm run gen:schema)", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../schema/policy.schema.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(policyJsonSchema());
  });
});
