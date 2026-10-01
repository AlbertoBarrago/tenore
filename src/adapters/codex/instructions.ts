import type { InstructionBlock, MemoryBlock, Scope } from "../../ir/schema.ts";

/**
 * Codex has no import syntax, so sources are copied. Each block is wrapped in
 * HTML comment markers naming its origin, so import can route an edit made in
 * the generated file back to the right `.agents/` file.
 */
const BEGIN = /^<!-- tenore:begin (instructions|memory) (global|repo|local) (.+) -->$/;
const END = "<!-- tenore:end -->";

export interface Blocks {
  instructions: { scope: Scope; ref: string; body: string }[];
  memory: MemoryBlock[];
  /** Text outside any marker: added by hand to the generated file. */
  loose: string;
}

/** `ref` is the source path relative to the repo/home root (instructions) or the topic (memory). */
export function renderBlocks(
  instructions: { block: InstructionBlock; ref: string }[],
  memory: MemoryBlock[],
): string {
  const parts = [
    ...instructions.map(
      ({ block, ref }) =>
        `<!-- tenore:begin instructions ${block.scope} ${ref} -->\n${trimEnd(block.body)}\n${END}`,
    ),
    ...memory.map(
      (m) => `<!-- tenore:begin memory ${m.scope} ${m.topic} -->\n${trimEnd(m.body)}\n${END}`,
    ),
  ];
  return `${parts.join("\n\n")}\n`;
}

export function parseBlocks(body: string): Blocks {
  const out: Blocks = { instructions: [], memory: [], loose: "" };
  const loose: string[] = [];
  let current: { kind: string; scope: Scope; ref: string; lines: string[] } | undefined;

  for (const line of body.split("\n")) {
    if (current) {
      if (line === END) {
        const text = `${current.lines.join("\n")}\n`;
        if (current.kind === "memory")
          out.memory.push({ topic: current.ref, scope: current.scope, body: text });
        else out.instructions.push({ scope: current.scope, ref: current.ref, body: text });
        current = undefined;
      } else {
        current.lines.push(line);
      }
      continue;
    }
    const m = BEGIN.exec(line);
    if (m?.[1] && m[2] && m[3])
      current = { kind: m[1], scope: m[2] as Scope, ref: m[3], lines: [] };
    else loose.push(line);
  }
  // An unterminated block (marker deleted by hand) is kept as loose text, never dropped.
  if (current) loose.push(...current.lines);
  const rest = loose.join("\n").trim();
  out.loose = rest === "" ? "" : `${rest}\n`;
  return out;
}

/**
 * Bodies are stored without their trailing newlines inside markers and get
 * exactly one back on parse; a body that ended with blank lines loses them.
 */
function trimEnd(text: string): string {
  return text.replace(/\n+$/, "");
}
