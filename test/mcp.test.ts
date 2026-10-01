import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main, VERSION } from "../src/cli.ts";
import { writeTree } from "./helpers.ts";

/** Runs `tenore mcp` in-process: sends each message as one line, returns the parsed replies. */
async function session(root: string, home: string, messages: unknown[], args: string[] = []) {
  const stdin = new PassThrough();
  let out = "";
  const protocolOut = new Writable({
    write(chunk, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  const io = { stdin, protocolOut, stdout: () => {}, stderr: () => {}, cwd: root, home };
  const running = main(["mcp", ...args], io);
  for (const m of messages)
    stdin.write(typeof m === "string" ? `${m}\n` : `${JSON.stringify(m)}\n`);
  stdin.end();
  expect(await running).toBe(0);
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const text = (reply: { result: { content: { text: string }[] } }) => reply.result.content[0]?.text;

describe("tenore mcp: protocol", () => {
  it("negotiates the protocol version and lists the tools", async () => {
    const root = await writeTree({});
    const replies = await session(root, root, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ]);
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(replies[0].result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "tenore", version: VERSION },
    });
    expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual([
      "memory_list",
      "memory_read",
      "memory_search",
      "memory_write",
    ]);
    expect(replies[2].result.protocolVersion).toBe("2025-11-25");
    expect(replies[3].result).toEqual({});
  });

  it("reports parse errors, unknown methods and unknown tools as JSON-RPC errors", async () => {
    const root = await writeTree({});
    const replies = await session(root, root, [
      "{ not json",
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      call(2, "rm_rf", {}),
    ]);
    expect(replies.map((r) => r.error?.code)).toEqual([-32700, -32601, -32602]);
  });
});

describe("tenore mcp: memory tools", () => {
  it("writes, lists, reads and searches memory; sync then picks the topic up", async () => {
    const root = await writeTree({ ".agents/AGENTS.md": "rules\n" });
    const home = await writeTree({});
    const replies = await session(root, home, [
      call(1, "memory_write", { topic: "stack", body: "TypeScript, ESM.\nvitest for tests" }),
      call(2, "memory_write", { topic: "secrets", body: "never commit .env", scope: "local" }),
      call(3, "memory_list", {}),
      call(4, "memory_read", { topic: "stack" }),
      call(5, "memory_search", { query: "VITEST" }),
      call(6, "memory_write", { topic: "stack", body: "TypeScript only\n" }),
    ]);
    expect(text(replies[0])).toBe(
      "created repo/stack; run `tenore sync` so agents load the new topic",
    );
    expect(text(replies[2])).toBe("repo/stack\nlocal/secrets");
    expect(text(replies[3])).toBe("# repo/stack\n\nTypeScript, ESM.\nvitest for tests\n");
    expect(text(replies[4])).toBe("repo/stack:2: vitest for tests");
    expect(text(replies[5])).toBe("updated repo/stack");
    expect(await readFile(join(root, ".agents/memory/stack.md"), "utf8")).toBe("TypeScript only\n");
    expect(await readFile(join(root, ".agents/local/memory/secrets.md"), "utf8")).toBe(
      "never commit .env\n",
    );

    let out = "";
    await main(["sync", "--target", "claude"], {
      stdout: (t) => {
        out += t;
      },
      stderr: () => {},
      cwd: root,
      home,
    });
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("@.agents/memory/stack.md");
    expect(out).toContain("create         CLAUDE.md");
  });

  it.each([["../escape"], ["a/b"], [".hidden"], ["topic.md"], ["x".repeat(65)], [""]])(
    "refuses unsafe topic %j",
    async (topic) => {
      const root = await writeTree({});
      const [reply] = await session(root, root, [call(1, "memory_write", { topic, body: "x" })]);
      expect(reply.result.isError).toBe(true);
    },
  );

  it("refuses the global scope unless started with --global", async () => {
    const root = await writeTree({});
    const home = await writeTree({});
    const [denied] = await session(root, home, [
      call(1, "memory_write", { topic: "t", body: "x", scope: "global" }),
    ]);
    expect(denied.result.isError).toBe(true);
    const [allowed] = await session(
      root,
      home,
      [call(1, "memory_write", { topic: "t", body: "x", scope: "global" })],
      ["--global"],
    );
    expect(allowed.result.isError).toBeUndefined();
    expect(await readFile(join(home, ".agents/memory/t.md"), "utf8")).toBe("x\n");
  });

  it("caps the body size and reports missing topics as tool errors", async () => {
    const root = await writeTree({});
    const replies = await session(root, root, [
      call(1, "memory_write", { topic: "big", body: "x".repeat(64 * 1024 + 1) }),
      call(2, "memory_read", { topic: "nope" }),
    ]);
    expect(replies.map((r) => r.result.isError)).toEqual([true, true]);
  });
});
