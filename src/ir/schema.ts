import { z } from "zod";

/**
 * Canonical IR and `policy.md` frontmatter schema.
 *
 * This module is the single definition of the data model: TypeScript types are
 * inferred from it and `schema/policy.schema.json` is generated from it
 * (`npm run gen:schema`). Constraints that JSON Schema cannot express are
 * implemented as zod refinements and are only enforced by `tenore check`/`sync`.
 */

export const SCOPES = ["global", "repo", "local"] as const;
export const ScopeSchema = z.enum(SCOPES);
/** Config layer, from widest to narrowest. Merge order follows this array. */
export type Scope = z.infer<typeof ScopeSchema>;

export const ADAPTER_IDS = ["claude", "codex", "gemini", "antigravity"] as const;
export const AdapterIdSchema = z.enum(ADAPTER_IDS);
export type AdapterId = z.infer<typeof AdapterIdSchema>;

export const PermissionLevelSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const NetworkLevelSchema = z.enum(["none", "restricted", "full"]);
export type NetworkLevel = z.infer<typeof NetworkLevelSchema>;

/**
 * MCP server name. Targets build tool identifiers by joining server and tool
 * (Claude: `mcp__<server>__<tool>`), so `.` and `__` would make that mapping
 * ambiguous and are rejected here rather than escaped later.
 */
export const MCP_SERVER_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

/** `<server>.<tool>` or `<server>.*` */
const MCP_TOOL_REF = new RegExp(
  `^${MCP_SERVER_NAME.source.slice(1, -1)}\\.(?:\\*|[A-Za-z0-9_-]+)$`,
);

/**
 * A string where every `${...}` placeholder is an env reference `${env:VAR}`.
 * Encoded as a regex (not a refinement) so editors get the same validation
 * through the generated JSON Schema.
 */
const ENV_TEMPLATE = /^(?:[^$]|\$(?!\{)|\$\{env:[A-Za-z_][A-Za-z0-9_]*\})*$/;

const EnvTemplateString = z.string().regex(ENV_TEMPLATE, {
  message: "only ${env:VAR} placeholders are allowed",
});

const nonEmpty = z.string().min(1);

export const CapabilitySchema = z
  .union([
    z.strictObject({ shell: nonEmpty.describe("Glob on the full command line") }),
    z.strictObject({ "fs.read": nonEmpty.describe("Gitignore-style glob on the path") }),
    z.strictObject({ "fs.write": nonEmpty.describe("Gitignore-style glob on the path") }),
    z.strictObject({ network: NetworkLevelSchema }),
    z.strictObject({
      mcp: z.string().regex(MCP_TOOL_REF, { message: "expected <server>.<tool> or <server>.*" }),
    }),
  ])
  .meta({ id: "Capability" });
export type Capability = z.infer<typeof CapabilitySchema>;

const CapabilityList = z.array(CapabilitySchema).superRefine((caps, ctx) => {
  // `network` is a scalar living inside a list: two entries in the same list
  // would be contradictory or redundant, so reject instead of picking one.
  const count = caps.filter((c) => "network" in c).length;
  if (count > 1) {
    ctx.addIssue({ code: "custom", message: "at most one `network` capability per list" });
  }
});

export const McpServerSchema = z
  .strictObject({
    command: EnvTemplateString.min(1),
    args: z.array(EnvTemplateString).optional(),
    env: z.record(z.string(), EnvTemplateString).optional(),
  })
  .meta({ id: "McpServer" });
export type McpServer = z.infer<typeof McpServerSchema>;

const McpServers = z.record(
  z.string().regex(MCP_SERVER_NAME, { message: "server names may not contain '.' or '__'" }),
  McpServerSchema,
);

/**
 * Adapters `sync`/`diff`/`check` run by default. The narrowest scope that sets
 * it wins; `--target` on the command line wins over all of them.
 */
const Targets = z
  .array(AdapterIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, { message: "targets must be unique" })
  .describe("Adapters to run by default (narrowest scope wins; --target overrides)");

const Overrides = z.partialRecord(AdapterIdSchema, z.record(z.string(), z.unknown()));

/** Frontmatter of `.agents/policy.md`. Every field is optional per layer. */
export const PolicySchema = z
  .strictObject({
    permissions: z
      .strictObject({
        default: PermissionLevelSchema.optional(),
        allow: CapabilityList.optional(),
        ask: CapabilityList.optional(),
        deny: CapabilityList.optional(),
      })
      .optional(),
    mcp: McpServers.optional(),
    targets: Targets.optional(),
    overrides: Overrides.optional(),
  })
  .meta({
    title: "tenore policy",
    description: "Frontmatter of .agents/policy.md",
  });
export type Policy = z.infer<typeof PolicySchema>;

export const InstructionBlockSchema = z.strictObject({
  /** Absolute path of the file the block was read from. */
  source: z.string(),
  scope: ScopeSchema,
  body: z.string(),
});
export type InstructionBlock = z.infer<typeof InstructionBlockSchema>;

export const MemoryBlockSchema = z.strictObject({
  topic: z.string().min(1),
  scope: ScopeSchema,
  body: z.string(),
});
export type MemoryBlock = z.infer<typeof MemoryBlockSchema>;

export const PermissionsSchema = z.strictObject({
  default: PermissionLevelSchema,
  allow: CapabilityList,
  ask: CapabilityList,
  deny: CapabilityList,
});
export type Permissions = z.infer<typeof PermissionsSchema>;

/**
 * Fully merged canonical model.
 *
 * `overrides` is a partial record: an adapter with no overrides has no key,
 * which keeps round-trip equality independent of which adapters exist.
 */
export const IrSchema = z.strictObject({
  version: z.literal(1),
  instructions: z.array(InstructionBlockSchema),
  memory: z.array(MemoryBlockSchema),
  permissions: PermissionsSchema,
  mcp: McpServers,
  /** Absent when no layer sets it: callers fall back to every implemented adapter. */
  targets: Targets.optional(),
  overrides: Overrides,
});
export type Ir = z.infer<typeof IrSchema>;

/** The permission default used when no layer sets one (matches Claude's default mode). */
export const DEFAULT_PERMISSION: PermissionLevel = "ask";

/** Returns an IR with no content, the identity element of merge. */
export function emptyIr(): Ir {
  return {
    version: 1,
    instructions: [],
    memory: [],
    permissions: { default: DEFAULT_PERMISSION, allow: [], ask: [], deny: [] },
    mcp: {},
    overrides: {},
  };
}

/** JSON Schema for `policy.md` frontmatter, consumed by editors. */
export function policyJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PolicySchema, { target: "draft-2020-12" }) as Record<string, unknown>;
}
