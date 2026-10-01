#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("tenore")
  .description("Compile a single .agents/ source of truth into each coding agent's native config")
  .version("0.1.0");

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
