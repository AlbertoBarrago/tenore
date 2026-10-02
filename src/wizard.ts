import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as clack from "@clack/prompts";
import { adapters, IMPLEMENTED } from "./adapters/index.ts";
import type { ImportResult } from "./adapters/types.ts";
import {
  adoptNative,
  ensureGitignore,
  isEmpty,
  missingGitignoreLines,
  scaffold,
  updatePolicy,
} from "./init.ts";
import { dedupe } from "./ir/canonical.ts";
import { layerDirs, parseLayers } from "./ir/parse.ts";
import type { AdapterId, McpServer, Policy, Scope } from "./ir/schema.ts";
import { layerFiles } from "./ir/serialize.ts";
import { display, renderDiff } from "./sync/diff.ts";
import { applyPlan, BLOCKING, planSync } from "./sync/plan.ts";
import { readOptional, writeAtomic } from "./sync/write.ts";

/**
 * Interactive `tenore init`. Every answer is collected before anything is
 * written, so cancelling (Ctrl+C) leaves the repository untouched. Each step
 * prints the equivalent non-interactive command, so the wizard also teaches
 * the CLI.
 */

export interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** The questions the wizard asks; injected so tests and `--yes` can answer them. */
export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  warn(message: string): void;
  multiselect<T extends string>(o: {
    message: string;
    options: Option<T>[];
    initialValues: T[];
    required: boolean;
  }): Promise<T[]>;
  select<T extends string>(o: {
    message: string;
    options: Option<T>[];
    initialValue: T;
  }): Promise<T>;
  confirm(o: { message: string; initialValue: boolean }): Promise<boolean>;
}

export class WizardCancelled extends Error {}

export function clackPrompter(): Prompter {
  const unwrap = <T>(value: T | symbol): T => {
    if (clack.isCancel(value)) throw new WizardCancelled("cancelled");
    return value as T;
  };
  const toClack = <T extends string>(options: Option<T>[]): clack.Option<T>[] =>
    options.map((x) =>
      x.hint
        ? { value: x.value, label: x.label, hint: x.hint }
        : { value: x.value, label: x.label },
    ) as clack.Option<T>[];
  return {
    intro: (t) => clack.intro(t),
    outro: (m) => clack.outro(m),
    note: (m, t) => clack.note(m, t),
    info: (m) => clack.log.info(m),
    warn: (m) => clack.log.warn(m),
    multiselect: async <T extends string>(o: {
      message: string;
      options: Option<T>[];
      initialValues: T[];
      required: boolean;
    }) =>
      unwrap<T[]>(
        await clack.multiselect<T>({
          message: o.message,
          options: toClack(o.options),
          initialValues: o.initialValues,
          required: o.required,
        }),
      ),
    select: async <T extends string>(o: {
      message: string;
      options: Option<T>[];
      initialValue: T;
    }) =>
      unwrap<T>(
        await clack.select<T>({
          message: o.message,
          options: toClack(o.options),
          initialValue: o.initialValue,
        }),
      ),
    confirm: async (o) =>
      unwrap<boolean>(await clack.confirm({ message: o.message, initialValue: o.initialValue })),
  };
}

/** `--yes`: every question takes its default; the choices are still printed. */
export function defaultsPrompter(print: (text: string) => void): Prompter {
  return {
    intro: (t) => print(`${t}\n`),
    outro: (m) => print(`${m}\n`),
    note: (m, t) => print(`${t ? `${t}:\n` : ""}${m}\n`),
    info: (m) => print(`${m}\n`),
    warn: (m) => print(`warning: ${m}\n`),
    multiselect: async (o) => {
      print(`${o.message} ${o.initialValues.join(", ") || "(none)"}\n`);
      return o.initialValues;
    },
    select: async (o) => {
      print(`${o.message} ${o.initialValue}\n`);
      return o.initialValue;
    },
    confirm: async (o) => {
      print(`${o.message} ${o.initialValue ? "yes" : "no"}\n`);
      return o.initialValue;
    },
  };
}

/** Native files that reveal an existing setup, per adapter (shown as hints). */
const NATIVE_FILES: Record<AdapterId, string[]> = {
  claude: [
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".mcp.json",
  ],
  codex: ["AGENTS.md", "AGENTS.override.md", ".codex/config.toml", ".codex/rules"],
  antigravity: ["GEMINI.md", ".agents/mcp_config.json", ".agents/rules"],
  gemini: [],
};

/** The same, relative to the home directory, for the global scope. */
const GLOBAL_NATIVE_FILES: Record<AdapterId, string[]> = {
  claude: [".claude/CLAUDE.md", ".claude/settings.json"],
  codex: [".codex/AGENTS.md", ".codex/config.toml", ".codex/rules/tenore.rules"],
  antigravity: [
    ".gemini/AGENTS.md",
    ".gemini/GEMINI.md",
    ".gemini/antigravity-cli/settings.json",
    ".gemini/config/mcp_config.json",
  ],
  gemini: [],
};

const LABELS: Record<AdapterId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  antigravity: "Antigravity",
  gemini: "Gemini CLI",
};

const TELEMACO_SERVER: McpServer = { command: "telemaco", args: ["mcp"] };

export interface WizardOptions {
  root: string;
  home: string;
  /** `true` for `tenore init --global`: works on ~/.agents and the agents' user config. */
  global?: boolean;
  prompter: Prompter;
  print: (text: string) => void;
  /** Whether a command is on PATH; injectable for tests. */
  onPath?: (command: string) => boolean;
}

export async function runWizard(options: WizardOptions): Promise<number> {
  const { root, home, prompter: p } = options;
  const global = options.global === true;
  const onPath = options.onPath ?? isOnPath;
  const flag = global ? " --global" : "";
  const sourceDir = global ? "~/.agents/" : ".agents/";
  const scopes: Scope[] = global ? ["global"] : ["repo", "local"];
  const mainScope: Scope = global ? "global" : "repo";
  const show = (path: string) => (global ? `~/${display(path, home)}` : display(path, root));
  const commands: string[] = [];
  p.intro(`tenore init${flag}`);
  if (global) {
    p.info(
      "Your personal setup: ~/.agents/ is the source, ~/.claude, ~/.codex and ~/.gemini are generated from it.",
    );
  }

  // 1. Existing native config to import (only into an empty source layer).
  const layers = await parseLayers(root, home);
  const layer = layers.find((l) => l.scope === mainScope);
  const initialized =
    layer !== undefined &&
    (layer.instructions.length > 0 ||
      layer.memory.length > 0 ||
      Object.keys(layer.policy).length > 0);
  let combined: Partial<Record<Scope, ImportResult>> = {};
  let importedFrom: AdapterId[] = [];

  if (initialized) {
    p.info(
      `${sourceDir} already exists: skipping import (re-import with \`tenore init --import <agent>${flag} --force\`).`,
    );
  } else {
    const base = global ? home : root;
    const files = global ? GLOBAL_NATIVE_FILES : NATIVE_FILES;
    const found = IMPLEMENTED.map((id) => ({
      id,
      files: files[id].filter((f) => existsSync(join(base, f))),
    })).filter((x) => x.files.length > 0);
    if (found.length === 0) {
      p.info("No existing agent config found: starting from a template.");
    } else {
      importedFrom = await p.multiselect({
        message: `Existing agent config found. Which ones should be imported into ${sourceDir}?`,
        options: found.map((x) => ({
          value: x.id,
          label: LABELS[x.id],
          hint: x.files.map((f) => (global ? `~/${f}` : f)).join(", "),
        })),
        initialValues: found.map((x) => x.id),
        required: false,
      });
      combined = await combineImports(importedFrom, scopes, root, home, p);
      for (const id of importedFrom) commands.push(`tenore init --import ${id}${flag}`);
    }
  }

  // 2. Targets.
  const targets = await p.multiselect({
    message: "Which agents should tenore generate files for? (targets)",
    options: IMPLEMENTED.map((id) => ({ value: id, label: LABELS[id] })),
    initialValues:
      layer?.policy.targets ?? (importedFrom.length > 0 ? importedFrom : [...IMPLEMENTED]),
    required: true,
  });
  if (targets.includes("codex") && targets.includes("antigravity")) {
    p.warn(
      "Codex and Antigravity together: Antigravity also reads the AGENTS.md generated for Codex, so it sees the instructions twice.",
    );
  }
  commands.push(`tenore init --targets ${targets.join(",")}${flag}`);

  // 3. .gitignore (a repository concern only).
  const missing = global ? [] : await missingGitignoreLines(root);
  const gitignore =
    missing.length > 0 &&
    (await p.confirm({
      message: `Add personal files to .gitignore? (${missing.join(", ")})`,
      initialValue: true,
    }));

  // 4. Optional MCP servers.
  const memory = await p.confirm({
    message: `Register the tenore memory MCP server (shared ${sourceDir}memory for every agent)?`,
    initialValue: false,
  });
  if (memory && global && targets.includes("claude")) {
    p.warn(
      "Claude Code keeps user-level MCP servers in ~/.claude.json, which tenore does not write: add it there with `claude mcp add`.",
    );
  }
  let telemaco = false;
  let blockNativeWeb = false;
  if (onPath("telemaco")) {
    telemaco = await p.confirm({
      message: "telemaco is installed: use it for web access through MCP?",
      initialValue: false,
    });
    if (telemaco) {
      blockNativeWeb = await p.confirm({
        message:
          "Also block each agent's native web tools (network: none), so the web goes only through telemaco?",
        initialValue: false,
      });
    }
  }

  // 5. Confirm, then write everything.
  const summary = [
    importedFrom.length > 0
      ? `import: ${importedFrom.map((id) => LABELS[id]).join(", ")}`
      : initialized
        ? ""
        : `create ${sourceDir} from a template`,
    `targets: ${targets.join(", ")}`,
    gitignore ? `.gitignore: ${missing.join(", ")}` : "",
    memory ? "mcp: tenore-memory" : "",
    telemaco ? `mcp: telemaco${blockNativeWeb ? " (native web blocked)" : ""}` : "",
  ].filter((l) => l !== "");
  p.note(summary.join("\n"), "About to write");
  if (!(await p.confirm({ message: `Write ${sourceDir} now?`, initialValue: true })))
    throw new WizardCancelled("cancelled");

  if (!initialized && importedFrom.length === 0) {
    await scaffold(root, home, global ? "global" : "repo", { gitignore: false });
  }
  const dirs = layerDirs(root, home);
  for (const scope of scopes) {
    const imported = combined[scope];
    if (!imported || isEmpty(imported)) continue;
    for (const [path, content] of Object.entries(layerFiles(dirs[scope], imported))) {
      if ((await readOptional(path)) !== content) await writeAtomic(path, content);
    }
  }
  const memoryServer: McpServer = {
    command: "npx",
    args: ["-y", "tenore-cli", "mcp", ...(global ? ["--global"] : [])],
  };
  const { lostComments } = await updatePolicy(root, home, mainScope, (policy) => {
    const next: Policy = { ...policy, targets };
    const mcp = { ...(policy.mcp ?? {}) };
    if (memory) mcp["tenore-memory"] ??= memoryServer;
    if (telemaco) mcp.telemaco ??= TELEMACO_SERVER;
    if (Object.keys(mcp).length > 0) next.mcp = mcp;
    if (telemaco) {
      const perms = { ...(policy.permissions ?? {}) };
      perms.ask = dedupe([...(perms.ask ?? []), { mcp: "telemaco.*" }]);
      if (blockNativeWeb) perms.deny = dedupe([...(perms.deny ?? []), { network: "none" }]);
      next.permissions = perms;
    }
    return next;
  });
  if (lostComments)
    p.warn(`${sourceDir}policy.md was rewritten: YAML comments in it were not kept.`);
  if (gitignore) await ensureGitignore(root);
  for (const id of importedFrom) await adoptNative(adapters[id], root, home, scopes);
  if (memory || telemaco) commands.push(`edit ${sourceDir}policy.md (mcp, permissions)`);

  // 6. Sync (for the global scope, offer the full diff first: it is the user's own config).
  const plan = await planSync(
    targets.map((id) => adapters[id]),
    await parseLayers(root, home),
    scopes,
    root,
    home,
  );
  const changes = plan.actions.filter((a) => a.kind !== "unchanged");
  if (changes.length > 0) {
    p.note(
      changes.map((a) => `${a.kind.padEnd(10)} ${show(a.path)}`).join("\n"),
      `tenore sync${flag} would`,
    );
    if (global && (await p.confirm({ message: "Show the full diff first?", initialValue: true }))) {
      options.print(renderDiff(plan, home));
    }
  }
  for (const w of plan.warnings) p.warn(`[${w.code}] ${w.message}`);
  let code = 0;
  if (
    changes.length > 0 &&
    (await p.confirm({ message: `Run tenore sync${flag} now?`, initialValue: true }))
  ) {
    await applyPlan(plan);
    commands.push(`tenore sync${flag}`);
    const blocking = plan.actions.filter((a) => BLOCKING.includes(a.kind));
    if (blocking.length > 0) {
      code = 1;
      p.warn(
        `${blocking.length} file(s) not written (${blocking.map((a) => show(a.path)).join(", ")}): run \`tenore diff${flag}\` to see why.`,
      );
    }
  }

  p.note(commands.map((c) => `  ${c}`).join("\n"), "Equivalent commands");
  p.outro(`Done. Edit ${sourceDir} and run \`tenore sync${flag}\` whenever it changes.`);
  return code;
}

/**
 * Merges the imports of several agents for a first setup. Unlike
 * `init --import` (where the native files are authoritative), nothing is
 * dropped: rules, servers and memory are united. When agents carry different
 * instructions, the user picks which becomes `.agents/AGENTS.md`.
 */
async function combineImports(
  ids: readonly AdapterId[],
  scopes: readonly Scope[],
  root: string,
  home: string,
  p: Prompter,
): Promise<Partial<Record<Scope, ImportResult>>> {
  const out: Partial<Record<Scope, ImportResult>> = {};
  for (const scope of scopes) {
    const results: { id: AdapterId; result: ImportResult }[] = [];
    for (const id of ids) {
      const result = await adapters[id].import(root, { scope, root, home });
      if (!isEmpty(result)) results.push({ id, result });
    }
    if (results.length === 0) continue;

    // A CLAUDE.md that only says `@AGENTS.md` is a pointer, not content.
    const withText = results.filter((r) =>
      r.result.instructions.some((i) => !isPointerOnly(i.body)),
    );
    const distinct = new Map(
      withText.map((r) => [r.result.instructions.map((i) => i.body).join("\n"), r.id]),
    );
    let chosen = withText;
    if (distinct.size > 1) {
      const pick = await p.select<string>({
        message: `Different ${scope} instructions found. Which should become ${scope === "global" ? "~/.agents/" : scope === "local" ? ".agents/local/" : ".agents/"}AGENTS.md?`,
        options: [
          ...withText.map((r) => ({
            value: r.id,
            label: LABELS[r.id],
            hint: r.result.instructions.map((i) => display(i.source, root)).join(", "),
          })),
          { value: "all", label: "All of them, concatenated" },
        ],
        initialValue: withText[0]?.id ?? "all",
      });
      chosen = pick === "all" ? withText : withText.filter((r) => r.id === pick);
    } else if (distinct.size === 1) {
      chosen = withText.slice(0, 1);
    }

    const memory = new Map<string, ImportResult["memory"][number]>();
    for (const r of results)
      for (const m of r.result.memory) if (!memory.has(m.topic)) memory.set(m.topic, m);

    out[scope] = {
      instructions: chosen.flatMap((r) => r.result.instructions),
      memory: [...memory.values()],
      policy: results.reduce<Policy>((acc, r) => unionPolicy(acc, r.result.policy), {}),
      warnings: results.flatMap((r) => r.result.warnings),
    };
  }
  return out;
}

function isPointerOnly(body: string): boolean {
  const lines = body.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
  return lines.length > 0 && lines.every((l) => /^@\S+$/.test(l.trim()));
}

/** First setup: keep everything from every agent (first one wins on name clashes). */
function unionPolicy(a: Policy, b: Policy): Policy {
  const out: Policy = {};
  const perms: NonNullable<Policy["permissions"]> = {};
  const def = a.permissions?.default ?? b.permissions?.default;
  if (def !== undefined) perms.default = def;
  for (const list of ["allow", "ask", "deny"] as const) {
    const caps = dedupe([...(a.permissions?.[list] ?? []), ...(b.permissions?.[list] ?? [])]);
    if (caps.length > 0) perms[list] = caps;
  }
  if (Object.keys(perms).length > 0) out.permissions = perms;
  const mcp = { ...(b.mcp ?? {}), ...(a.mcp ?? {}) };
  if (Object.keys(mcp).length > 0) out.mcp = mcp;
  const overrides = { ...(b.overrides ?? {}), ...(a.overrides ?? {}) };
  if (Object.keys(overrides).length > 0) out.overrides = overrides;
  return out;
}

function isOnPath(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, command)));
}
