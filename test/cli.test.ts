import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { writeTree } from "./helpers.ts";

async function run(args: string[], root: string, home: string) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    cwd: root,
    home,
  });
  return { code, stdout, stderr };
}

const read = (root: string, rel: string) => readFile(join(root, rel), "utf8");

describe("cli", () => {
  it("init -> sync -> check -> diff on a new repo", async () => {
    const root = await writeTree({});
    const home = await writeTree({});
    await mkdir(join(root, ".jj"));

    const init = await run(["init"], root, home);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("write          .agents/AGENTS.md");
    expect(init.stdout).toContain(
      "added to .gitignore: .agents/local/, CLAUDE.local.md, AGENTS.override.md, .agents/rules/tenore-local.md",
    );
    expect(await read(root, ".agents/policy.md")).toContain("yaml-language-server: $schema=");

    expect((await run(["check"], root, home)).code).toBe(1);

    const sync = await run(["sync"], root, home);
    expect(sync.code).toBe(0);
    expect(sync.stdout).toContain("create         CLAUDE.md");
    expect(JSON.parse(await read(root, ".claude/settings.json"))).toEqual({
      permissions: { defaultMode: "default" },
    });

    expect(await run(["check"], root, home)).toMatchObject({ code: 0, stdout: "ok\n" });
    expect(await run(["diff"], root, home)).toMatchObject({ code: 0, stdout: "" });
    expect((await run(["init"], root, home)).stdout).toContain("nothing to do");
  });

  it("drift: sync refuses, check fails, init --import --force recovers the edit", async () => {
    const root = await writeTree({ ".agents/AGENTS.md": "rules\n" });
    const home = await writeTree({});
    await run(["sync"], root, home);
    await writeFile(
      join(root, "CLAUDE.md"),
      `${await read(root, "CLAUDE.md")}\nAlways answer in Italian.\n`,
    );

    const sync = await run(["sync"], root, home);
    expect(sync.code).toBe(1);
    expect(sync.stderr).toContain("drift          CLAUDE.md (edited since the last sync)");
    expect(sync.stderr).toContain("tenore init --import claude --force");
    expect((await run(["check"], root, home)).code).toBe(1);

    expect((await run(["init", "--import", "claude"], root, home)).code).toBe(1);
    const recovered = await run(["init", "--import", "claude", "--force"], root, home);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain("adopt          CLAUDE.md");
    expect(await read(root, ".agents/AGENTS.md")).toBe("rules\n\nAlways answer in Italian.\n");

    expect((await run(["sync"], root, home)).code).toBe(0);
    expect(await run(["check"], root, home)).toMatchObject({ code: 0 });
    expect(await read(root, "CLAUDE.md")).not.toContain("Always answer");
  });

  it("onboards an existing hand-written Claude setup", async () => {
    const root = await writeTree({
      "CLAUDE.md": "# Project\n\nSee @docs/guide.md\n",
      "docs/guide.md": "guide\n",
      ".claude/settings.json": JSON.stringify({
        model: "opus",
        permissions: { deny: ["Read(.env*)"] },
      }),
    });
    const home = await writeTree({});

    expect((await run(["sync"], root, home)).code).toBe(0); // nothing in .agents yet: nothing emitted
    expect((await run(["init", "--import", "claude"], root, home)).code).toBe(0);
    expect(await read(root, ".agents/AGENTS.md")).toBe("# Project\n\nSee @../docs/guide.md\n");
    expect(await read(root, ".agents/policy.md")).toContain("fs.read: .env*");

    expect((await run(["sync"], root, home)).code).toBe(0);
    expect(await read(root, "CLAUDE.md")).toContain("@.agents/AGENTS.md");
    expect(JSON.parse(await read(root, ".claude/settings.json"))).toEqual({
      model: "opus",
      permissions: { deny: ["Read(.env*)"] },
    });
    expect((await run(["check"], root, home)).code).toBe(0);
  });

  it("reports schema errors with file locations and exits 1", async () => {
    const root = await writeTree({
      ".agents/policy.md": "---\npermissions:\n  default: maybe\n---\n",
    });
    const res = await run(["check"], root, await writeTree({}));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/error: .*policy\.md: permissions\.default: /);
  });

  it("--global includes the home scope", async () => {
    const root = await writeTree({});
    const home = await writeTree({ ".agents/AGENTS.md": "global\n" });
    expect((await run(["sync"], root, home)).stdout).toBe("");
    expect((await run(["sync", "--global"], root, home)).stdout).toContain("create");
    expect(await read(home, ".claude/CLAUDE.md")).toContain("@~/.agents/AGENTS.md");
  });

  it("--help and --version exit 0", async () => {
    const root = await writeTree({});
    const { version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect((await run(["--version"], root, root)).stdout).toBe(`${version}\n`);
    const help = await run(["--help"], root, root);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("sync");
  });

  it("rejects unknown targets", async () => {
    const root = await writeTree({});
    expect((await run(["sync", "--target", "cursor"], root, root)).code).not.toBe(0);
  });
});

describe("cli: targets and --prune", () => {
  it("policy targets select adapters; --target overrides them", async () => {
    const root = await writeTree({
      ".agents/AGENTS.md": "rules\n",
      ".agents/policy.md": "---\ntargets: [claude]\n---\n",
    });
    const home = await writeTree({});
    expect((await run(["sync"], root, home)).stdout).toBe("create         CLAUDE.md\n");
    expect((await run(["diff", "--target", "codex"], root, home)).stdout).toContain(
      "+++ b/AGENTS.md",
    );
  });

  it("dropping a target reports its files as orphaned; --prune removes untouched ones", async () => {
    const root = await writeTree({ ".agents/AGENTS.md": "rules\n" });
    const home = await writeTree({});
    await run(["sync"], root, home);
    expect(await read(root, "AGENTS.md")).toContain("tenore:begin");

    await writeFile(join(root, ".agents/policy.md"), "---\ntargets: [claude]\n---\n");
    const kept = await run(["sync"], root, home);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toContain(
      "orphan         AGENTS.md (codex is not a target; run with --prune to remove it)",
    );
    expect(await read(root, "AGENTS.md")).toContain("tenore:begin");
    expect((await run(["check"], root, home)).code).toBe(0);

    const pruned = await run(["sync", "--prune"], root, home);
    expect(pruned.stdout).toContain("remove         AGENTS.md");
    await expect(read(root, "AGENTS.md")).rejects.toThrow();
    expect(JSON.parse(await read(root, ".agents/.lock")).artifacts).not.toHaveProperty([
      "AGENTS.md",
    ]);
  });

  it("--prune keeps an orphan that was edited by hand (drift)", async () => {
    const root = await writeTree({ ".agents/AGENTS.md": "rules\n" });
    const home = await writeTree({});
    await run(["sync"], root, home);
    await writeFile(join(root, "AGENTS.md"), "edited by hand\n");
    await writeFile(join(root, ".agents/policy.md"), "---\ntargets: [claude]\n---\n");
    const res = await run(["sync", "--prune"], root, home);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("drift          AGENTS.md");
    expect(await read(root, "AGENTS.md")).toBe("edited by hand\n");
  });

  it("rejects duplicate or unknown targets", async () => {
    for (const targets of ["[claude, claude]", "[]", "[cursor]"]) {
      const root = await writeTree({ ".agents/policy.md": `---\ntargets: ${targets}\n---\n` });
      expect((await run(["check"], root, await writeTree({}))).code).toBe(1);
    }
  });
});

describe("cli: init --import keeps personal files out of VCS (markasso regression)", () => {
  it("adds the local paths to .gitignore when importing local scope in a jj repo", async () => {
    const root = await writeTree({
      ".gitignore": "node_modules/\nCLAUDE.md\n.claude/\n",
      ".claude/settings.local.json": JSON.stringify({
        permissions: { allow: ["Bash(pnpm build)", "Bash(git status*)"] },
      }),
    });
    await mkdir(join(root, ".jj"));
    const home = await writeTree({});
    const res = await run(["init", "--import", "claude"], root, home);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("added to .gitignore: .agents/local/");
    const gitignore = await read(root, ".gitignore");
    expect(gitignore.startsWith("node_modules/\nCLAUDE.md\n.claude/\n")).toBe(true);
    expect(gitignore).toContain(".agents/local/\n");

    expect((await run(["sync"], root, home)).code).toBe(0);
    const check = await run(["check"], root, home);
    expect(check.stdout).toBe("ok\n");
    // Allow-only local rules are informational, not "NOT ENFORCED".
    expect(check.stderr).toContain("[codex-local-allow-ignored]");
    expect(check.stderr).toContain("[antigravity-project-allow-ignored]");
    expect(check.stderr).not.toContain("NOT ENFORCED");
  });

  it("keeps the loud warning when a local deny cannot be enforced", async () => {
    const root = await writeTree({
      ".agents/local/policy.md":
        "---\npermissions:\n  deny: [{ shell: 'git push --force*' }]\n---\n",
    });
    const res = await run(["check"], root, await writeTree({}));
    expect(res.stderr).toContain("[codex-local-policy-unsupported]");
    expect(res.stderr).toContain("[antigravity-project-permissions-unsupported]");
    expect(res.stderr).toContain("NOT ENFORCED");
  });

  it("does not touch .gitignore for a global-only import", async () => {
    const root = await writeTree({ ".gitignore": "x\n" });
    await mkdir(join(root, ".jj"));
    const home = await writeTree({ ".claude/CLAUDE.md": "global rules\n" });
    await run(["init", "--import", "claude", "--global"], root, home);
    expect(await read(root, ".gitignore")).toBe("x\n");
  });
});
