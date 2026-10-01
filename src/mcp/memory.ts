import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound, layerDirs, MEMORY_DIR, readText } from "../ir/parse.ts";
import type { Scope } from "../ir/schema.ts";
import { writeAtomic } from "../sync/write.ts";
import { type Tool, ToolError } from "./protocol.ts";

/**
 * Memory tools over `.agents/<scope>/memory/*.md`, the same files `sync`
 * compiles into each agent. Writes are confined to those directories: topics
 * are plain file stems (no separators, no `..`, no dotfiles) and bodies are
 * size-capped. The global scope is writable only when the server was started
 * with `--global`.
 */
export const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_BODY_BYTES = 64 * 1024;

export interface MemoryOptions {
  root: string;
  home: string;
  /** Scopes the tools may read and write. */
  scopes: readonly Scope[];
}

const SCOPE_SCHEMA = { type: "string", enum: ["global", "repo", "local"] };

export function memoryTools(options: MemoryOptions): Tool[] {
  const dirs = layerDirs(options.root, options.home);
  const memoryDir = (scope: Scope) => join(dirs[scope], MEMORY_DIR);
  const scopeArg = (value: unknown, fallback?: Scope): Scope | undefined => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !options.scopes.includes(value as Scope)) {
      throw new ToolError(`scope must be one of: ${options.scopes.join(", ")}`);
    }
    return value as Scope;
  };
  const topicArg = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      !TOPIC.test(value) ||
      value.includes("..") ||
      value.endsWith(".md")
    ) {
      throw new ToolError(
        "topic must be 1-64 characters of letters, digits, '.', '_' or '-' (no '..', no .md suffix)",
      );
    }
    return value;
  };

  const list = async (scope: Scope): Promise<string[]> => {
    try {
      return (await readdir(memoryDir(scope)))
        .filter((n) => n.endsWith(".md") && !n.startsWith("."))
        .map((n) => n.slice(0, -3))
        .sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  };

  return [
    {
      name: "memory_list",
      description: "List persistent memory topics (one Markdown file per topic) by scope.",
      inputSchema: {
        type: "object",
        properties: { scope: SCOPE_SCHEMA },
        additionalProperties: false,
      },
      async call(args) {
        const only = scopeArg(args.scope);
        const lines: string[] = [];
        for (const scope of only ? [only] : options.scopes) {
          for (const topic of await list(scope)) lines.push(`${scope}/${topic}`);
        }
        return lines.length > 0 ? lines.join("\n") : "no memory topics";
      },
    },
    {
      name: "memory_read",
      description:
        "Read a memory topic. Without scope, returns the topic from every scope that has it, widest first.",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" }, scope: SCOPE_SCHEMA },
        required: ["topic"],
        additionalProperties: false,
      },
      async call(args) {
        const topic = topicArg(args.topic);
        const only = scopeArg(args.scope);
        const parts: string[] = [];
        for (const scope of only ? [only] : options.scopes) {
          const body = await readText(join(memoryDir(scope), `${topic}.md`));
          if (body !== undefined) parts.push(`# ${scope}/${topic}\n\n${body}`);
        }
        if (parts.length === 0) throw new ToolError(`no memory topic "${topic}"`);
        return parts.join("\n");
      },
    },
    {
      name: "memory_search",
      description:
        "Case-insensitive search across memory topics; returns matching lines with their topic.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
        additionalProperties: false,
      },
      async call(args) {
        if (typeof args.query !== "string" || args.query.trim() === "")
          throw new ToolError("query must be a non-empty string");
        const needle = args.query.toLowerCase();
        const hits: string[] = [];
        for (const scope of options.scopes) {
          for (const topic of await list(scope)) {
            const body = (await readText(join(memoryDir(scope), `${topic}.md`))) ?? "";
            body.split("\n").forEach((line, i) => {
              if (hits.length < 50 && line.toLowerCase().includes(needle))
                hits.push(`${scope}/${topic}:${i + 1}: ${line}`);
            });
          }
        }
        return hits.length > 0 ? hits.join("\n") : "no matches";
      },
    },
    {
      name: "memory_write",
      description:
        "Create or replace a memory topic (Markdown). Defaults to the repo scope. Run `tenore sync` afterwards so new topics reach every agent.",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" }, body: { type: "string" }, scope: SCOPE_SCHEMA },
        required: ["topic", "body"],
        additionalProperties: false,
      },
      async call(args) {
        const topic = topicArg(args.topic);
        const scope = scopeArg(
          args.scope,
          options.scopes.includes("repo") ? "repo" : options.scopes[0],
        ) as Scope;
        if (typeof args.body !== "string") throw new ToolError("body must be a string");
        if (Buffer.byteLength(args.body, "utf8") > MAX_BODY_BYTES) {
          throw new ToolError(`body exceeds ${MAX_BODY_BYTES} bytes`);
        }
        const isNew = !(await list(scope)).includes(topic);
        const body = args.body.endsWith("\n") ? args.body : `${args.body}\n`;
        await writeAtomic(join(memoryDir(scope), `${topic}.md`), body);
        return `${isNew ? "created" : "updated"} ${scope}/${topic}${isNew ? "; run `tenore sync` so agents load the new topic" : ""}`;
      },
    },
  ];
}
