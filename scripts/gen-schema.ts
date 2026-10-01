/**
 * Writes schema/policy.schema.json from the zod source of truth.
 * `test/schema.test.ts` fails when the committed file is stale.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { policyJsonSchema } from "../src/ir/schema.ts";

const out = fileURLToPath(new URL("../schema/policy.schema.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(policyJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
