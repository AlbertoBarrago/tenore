import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 with the
 * `initialize`, `ping`, `tools/list` and `tools/call` methods. tenore needs no
 * other MCP feature, and this avoids the official SDK's HTTP transport stack.
 * Spec: https://modelcontextprotocol.io/specification (stdio transport, tools).
 */

/** Newest first; a client asking for one of these gets it back, otherwise the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns text for the model; throwing a ToolError reports `isError: true` instead of a protocol error. */
  call(args: Record<string, unknown>): Promise<string>;
}

/** An expected failure (bad topic, missing file): shown to the model, not a JSON-RPC error. */
export class ToolError extends Error {}

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface ServerInfo {
  name: string;
  version: string;
}

/** Serves until `input` ends; requests are handled sequentially. */
export async function serve(
  tools: readonly Tool[],
  info: ServerInfo,
  input: Readable,
  output: Writable,
): Promise<void> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);

  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } });
      continue;
    }
    // One request at a time, in arrival order: a read never races a write sent before it.
    const reply = await handle(message, byName, info);
    if (reply) send(reply);
  }
}

async function handle(
  message: unknown,
  tools: Map<string, Tool>,
  info: ServerInfo,
): Promise<Record<string, unknown> | undefined> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: INVALID_REQUEST, message: "invalid request" },
    };
  }
  const req = message as Request;
  const isNotification = !("id" in req) || req.id === undefined;
  // Responses from the client (we never send requests) and notifications get no reply.
  if (isNotification || typeof req.method !== "string") return undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code: number, msg: string) => ({
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message: msg },
  });

  try {
    switch (req.method) {
      case "initialize": {
        const asked = req.params?.protocolVersion;
        const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
        return reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: info });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: [...tools.values()].map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      case "tools/call": {
        const name = req.params?.name;
        const tool = typeof name === "string" ? tools.get(name) : undefined;
        if (!tool) return fail(INVALID_PARAMS, `unknown tool: ${String(name)}`);
        const args = req.params?.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          return fail(INVALID_PARAMS, "arguments must be an object");
        }
        try {
          const text = await tool.call(args as Record<string, unknown>);
          return reply({ content: [{ type: "text", text }] });
        } catch (error) {
          if (error instanceof ToolError) {
            return reply({ content: [{ type: "text", text: error.message }], isError: true });
          }
          throw error;
        }
      }
      default:
        return fail(METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  } catch (error) {
    // Unexpected failure: report it to the client, never crash the server loop.
    return fail(INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
  }
}
