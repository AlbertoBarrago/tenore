import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { parsePolicy } from "../src/ir/parse.ts";
import type { Prompter } from "../src/wizard.ts";
import { writeTree } from "./helpers.ts";

/**
 * Answers by matching a substring of the question; unanswered questions take
 * their default. `asked` records every question, in order.
 */
function scripted(answers: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const notes: string[] = [];
  const pick = <T>(message: string, fallback: T): T => {
    asked.push(message);
    const key = Object.keys(answers).find((k) => message.includes(k));
    return key === undefined ? fallback : (answers[key] as T);
  };
  const prompter: Prompter = {
    intro: () => {},
    outro: (m) => notes.push(m),
    note: (m, t) => notes.push(`${t ?? ""}\n${m}`),
    info: (m) => notes.push(m),
    warn: (m) => notes.push(`warn: ${m}`),
    multiselect: async (o) => pick(o.message, o.initialValues),
    select: async (o) => pick(o.message, o.initialValue),
    confirm: async (o) => pick(o.message, o.initialValue),
  };
  return { prompter, asked, notes };
}

async function wizard(
  root: string,
  home: string,
  answers?: Record<string, unknown>,
  installed: string[] = [],
) {
  const s = scripted(answers);
  let stdout = "";
  let stderr = "";
  const code = await main(["init"], {
    interactive: true,
    prompter: s.prompter,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    cwd: root,
    home,
    onPath: (cmd: string) => installed.includes(cmd),
  });
  return { code, stdout, stderr, ...s };
}

const read = (root: string, rel: string) => readFile(join(root, rel), "utf8");
const policyOf = async (root: string, rel = ".agents/policy.md") =>
  parsePolicy(rel, await read(root, rel)).policy;

const CONTRIBUTING = "# Contributing\n\nRun pnpm test before pushing.\n";

describe("tenore init wizard", () => {
  it("sets up a repo like markasso with the defaults", async () => {
    const root = await writeTree({
      "AGENTS.md": CONTRIBUTING,
      "CLAUDE.md": "@AGENTS.md\n",
      ".gitignore": "node_modules/\n",
      ".claude/settings.local.json": JSON.stringify({
        permissions: { allow: ["Bash(pnpm build)"] },
      }),
    });
    await mkdir(join(root, ".jj"));
    const home = await writeTree({});
    const res = await wizard(root, home);

    expect(res.code).toBe(0);
    expect(res.asked).toEqual([
      "Existing agent config found. Which ones should be imported into .agents/?",
      "Which agents should tenore generate files for? (targets)",
      expect.stringContaining("Add personal files to .gitignore?"),
      expect.stringContaining("Register the tenore memory MCP server"),
      "Write .agents/ now?",
      "Run tenore sync now?",
    ]);
    // The pointer-only CLAUDE.md did not compete with AGENTS.md: no "which instructions" question.
    expect(await read(root, ".agents/AGENTS.md")).toBe(CONTRIBUTING);
    expect((await policyOf(root)).targets).toEqual(["claude", "codex"]);
    expect((await policyOf(root, ".agents/local/policy.md")).permissions?.allow).toEqual([
      { shell: "pnpm build" },
    ]);
    expect(await read(root, ".gitignore")).toContain(".agents/local/");
    expect(await read(root, "CLAUDE.md")).toContain("@.agents/AGENTS.md");
    expect(await read(root, "AGENTS.md")).toContain("tenore:begin");
    expect(res.notes.join("\n")).toContain("tenore init --import claude");
    expect(res.notes.join("\n")).toContain("tenore init --targets claude,codex");

    const check = await main(["check"], { stdout: () => {}, stderr: () => {}, cwd: root, home });
    expect(check).toBe(0);
  });

  it("asks which instructions win when agents disagree", async () => {
    const root = await writeTree({ "AGENTS.md": "codex rules\n", "CLAUDE.md": "claude rules\n" });
    const res = await wizard(root, await writeTree({}), { "Different repo instructions": "codex" });
    expect(res.asked).toContain(
      "Different repo instructions found. Which should become .agents/AGENTS.md?",
    );
    expect(await read(root, ".agents/AGENTS.md")).toBe("codex rules\n");
  });

  it("can concatenate both instruction sets", async () => {
    const root = await writeTree({ "AGENTS.md": "codex rules\n", "CLAUDE.md": "claude rules\n" });
    await wizard(root, await writeTree({}), { "Different repo instructions": "all" });
    const body = await read(root, ".agents/AGENTS.md");
    expect(body).toContain("codex rules");
    expect(body).toContain("claude rules");
  });

  it("keeps MCP servers and rules from every imported agent (union, not authority)", async () => {
    const root = await writeTree({
      "AGENTS.md": "rules\n",
      ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["gh-mcp"] } } }),
      ".claude/settings.json": JSON.stringify({ permissions: { deny: ["mcp__gh__delete_repo"] } }),
    });
    await wizard(root, await writeTree({}));
    const policy = await policyOf(root);
    expect(policy.mcp?.gh).toEqual({ command: "npx", args: ["gh-mcp"] });
    expect(policy.permissions?.deny).toEqual([{ mcp: "gh.delete_repo" }]);
  });

  it("starts from a template in an empty repo and can add memory and telemaco", async () => {
    const root = await writeTree({});
    const home = await writeTree({});
    const res = await wizard(root, home, {
      "Which agents": ["claude"],
      "memory MCP": true,
    });
    expect(res.asked[0]).toBe("Which agents should tenore generate files for? (targets)");
    expect(await read(root, ".agents/AGENTS.md")).toContain("# Agent instructions");
    const policy = await policyOf(root);
    expect(policy.targets).toEqual(["claude"]);
    expect(policy.mcp?.["tenore-memory"]).toEqual({
      command: "npx",
      args: ["-y", "tenore-cli", "mcp"],
    });
  });

  it("offers telemaco only when installed, and can route the web through it", async () => {
    const root = await writeTree({});
    const res = await wizard(
      root,
      await writeTree({}),
      { "use it for web access": true, "Also block": true },
      ["telemaco"],
    );
    expect(res.asked.some((q) => q.includes("telemaco is installed"))).toBe(true);
    const policy = await policyOf(root);
    expect(policy.mcp?.telemaco).toEqual({ command: "telemaco", args: ["mcp"] });
    expect(policy.permissions?.ask).toEqual([{ mcp: "telemaco.*" }]);
    expect(policy.permissions?.deny).toEqual([{ network: "none" }]);
  });

  it("cancelling before writing leaves the repo untouched", async () => {
    const root = await writeTree({ "AGENTS.md": "rules\n" });
    const res = await wizard(root, await writeTree({}), { "Write .agents/ now?": false });
    expect(res.code).toBe(1);
    expect(res.stderr).toBe("cancelled: nothing was written\n");
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(await read(root, "AGENTS.md")).toBe("rules\n");
  });

  it("skips the import on an already initialized repo", async () => {
    const root = await writeTree({ ".agents/AGENTS.md": "x\n", "CLAUDE.md": "hand\n" });
    const res = await wizard(root, await writeTree({}), { "Run tenore sync": false });
    expect(res.asked[0]).toBe("Which agents should tenore generate files for? (targets)");
    expect(res.notes.join("\n")).toContain(".agents/ already exists");
  });
});

describe("tenore init flags", () => {
  const io = (root: string, home: string, out: string[]) => ({
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => out.push(t),
    cwd: root,
    home,
  });

  it("plain init without a TTY keeps the scriptable scaffold", async () => {
    const root = await writeTree({});
    const out: string[] = [];
    expect(await main(["init"], { ...io(root, root, out), interactive: false })).toBe(0);
    expect(out.join("")).toContain("write          .agents/AGENTS.md");
  });

  it("--yes runs the wizard with defaults, without a TTY", async () => {
    const root = await writeTree({ "AGENTS.md": "rules\n" });
    const out: string[] = [];
    expect(
      await main(["init", "--yes"], { ...io(root, await writeTree({}), out), interactive: false }),
    ).toBe(0);
    expect(out.join("")).toContain("Write .agents/ now? yes");
    expect(await read(root, ".agents/AGENTS.md")).toBe("rules\n");
  });

  it("--targets writes the targets into policy.md", async () => {
    const root = await writeTree({});
    const out: string[] = [];
    expect(await main(["init", "--targets", "claude, codex"], io(root, root, out))).toBe(0);
    expect((await policyOf(root)).targets).toEqual(["claude", "codex"]);
    expect(out.join("")).toContain("targets: claude, codex");
  });

  it("--targets rejects unknown agents", async () => {
    const root = await writeTree({});
    const out: string[] = [];
    expect(await main(["init", "--targets", "claude,cursor"], io(root, root, out))).toBe(1);
    expect(out.join("")).toContain("--targets expects");
  });
});

describe("tenore init --global wizard", () => {
  async function globalWizard(home: string, answers: Record<string, unknown> = {}) {
    const s = scripted(answers);
    let stdout = "";
    const root = await writeTree({});
    const code = await main(["init", "--global"], {
      interactive: true,
      prompter: s.prompter,
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => {},
      cwd: root,
      home,
      onPath: () => false,
    });
    return { code, stdout, root, ...s };
  }

  it("imports the user's Claude setup into ~/.agents and syncs it back losslessly", async () => {
    const home = await writeTree({});
    const { cp } = await import("node:fs/promises");
    const { FIXTURES } = await import("./helpers.ts");
    await cp(join(FIXTURES, "claude-global/home"), home, { recursive: true });
    const originalMd = await read(home, ".claude/CLAUDE.md");
    const originalSettings = JSON.parse(await read(home, ".claude/settings.json"));

    const res = await globalWizard(home);
    expect(res.code).toBe(0);
    expect(res.asked).toEqual([
      "Existing agent config found. Which ones should be imported into ~/.agents/?",
      "Which agents should tenore generate files for? (targets)",
      expect.stringContaining("Register the tenore memory MCP server"),
      "Write ~/.agents/ now?",
      "Show the full diff first?",
      "Run tenore sync --global now?",
    ]);
    // No .gitignore question, the diff was printed, commands carry --global.
    expect(res.stdout).toContain("+++ b/.claude/CLAUDE.md");
    expect(res.notes.join("\n")).toContain("tenore init --import claude --global");
    expect(res.notes.join("\n")).toContain("tenore sync --global");

    expect(await read(home, ".agents/AGENTS.md")).toBe(originalMd);
    expect((await policyOf(home)).targets).toEqual(["claude"]);
    expect(await read(home, ".claude/CLAUDE.md")).toContain("@~/.agents/AGENTS.md");
    const settings = JSON.parse(await read(home, ".claude/settings.json"));
    const { permissions, ...rest } = settings;
    const { permissions: before, ...beforeRest } = originalSettings;
    expect(rest).toEqual(beforeRest);
    expect(permissions.defaultMode).toBe("auto");
    expect(permissions.additionalDirectories).toEqual(before.additionalDirectories);

    const check = await main(["check", "--global"], {
      stdout: () => {},
      stderr: () => {},
      cwd: res.root,
      home,
    });
    expect(check).toBe(0);
  });

  it("declining the sync leaves ~/.claude untouched", async () => {
    const home = await writeTree({ ".claude/CLAUDE.md": "my global rules\n" });
    await globalWizard(home, { "Run tenore sync --global": false });
    expect(await read(home, ".claude/CLAUDE.md")).toBe("my global rules\n");
    expect(await read(home, ".agents/AGENTS.md")).toBe("my global rules\n");
  });

  it("points the global memory server at ~/.agents with --global", async () => {
    const home = await writeTree({});
    await globalWizard(home, { "Which agents": ["codex"], "memory MCP": true });
    expect((await policyOf(home)).mcp?.["tenore-memory"]).toEqual({
      command: "npx",
      args: ["-y", "tenore-cli", "mcp", "--global"],
    });
  });
});
