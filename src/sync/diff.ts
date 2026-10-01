import { relative } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Action, Plan } from "./plan.ts";

/**
 * Unified diff of a plan: every pending write, including lock files.
 * Drift and conflicts are diffed too (what sync *would* write), so the user
 * can see what importing or discarding their edit means.
 */
export function renderDiff(plan: Plan, cwd: string): string {
  const parts: string[] = [];
  for (const action of plan.actions) {
    if (action.kind === "unchanged") continue;
    parts.push(patch(display(action.path, cwd), action.before, action.after, label(action)));
  }
  for (const lock of plan.locks)
    parts.push(patch(display(lock.path, cwd), lock.before, lock.after, "lock"));
  return parts.join("");
}

function label(action: Action): string {
  return action.reason ? `${action.kind}: ${action.reason}` : action.kind;
}

function patch(
  name: string,
  before: string | undefined,
  after: string | undefined,
  header: string,
): string {
  const body = createTwoFilesPatch(
    before === undefined ? "/dev/null" : `a/${name}`,
    after === undefined ? "/dev/null" : `b/${name}`,
    before ?? "",
    after ?? "",
    undefined,
    undefined,
    { context: 3 },
  ).replace(/^=+\n/, "");
  return `# ${header}\n${body}`;
}

/** Paths inside cwd are shown relative, others absolute (~ for home is left to the shell). */
export function display(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? path : rel;
}
