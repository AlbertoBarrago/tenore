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
    expect(init.stdout).toContain("added to .gitignore: .agents/local/, CLAUDE.local.md");
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
    expect((await run(["--version"], root, root)).stdout).toBe("0.1.0\n");
    const help = await run(["--help"], root, root);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("sync");
  });

  it("rejects unknown targets", async () => {
    const root = await writeTree({});
    expect((await run(["sync", "--target", "cursor"], root, root)).code).not.toBe(0);
  });
});
