import type { z } from "zod";

/**
 * Non-fatal finding: something was ignored, or a target could not express a
 * rule exactly and a more restrictive fallback was used.
 */
export interface Warning {
  /** Stable machine-readable identifier, e.g. `policy-body-ignored`. */
  code: string;
  message: string;
  /** File the warning refers to, when there is one. */
  path?: string;
}

/** A single validation problem located in a source file. */
export interface Issue {
  path: string;
  /** Dotted location inside the document, empty for file-level problems. */
  at: string;
  message: string;
}

/** Fatal error for invalid `.agents/` sources. Carries every issue found, not only the first. */
export class SourceError extends Error {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    super(issues.map(formatIssue).join("\n"));
    this.name = "SourceError";
    this.issues = issues;
  }
}

export function formatIssue(issue: Issue): string {
  return issue.at
    ? `${issue.path}: ${issue.at}: ${issue.message}`
    : `${issue.path}: ${issue.message}`;
}

/** Converts zod issues into file-located issues. */
export function fromZod(path: string, error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path, at: i.path.map(String).join("."), message: i.message }));
}
