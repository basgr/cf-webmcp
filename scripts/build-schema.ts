/**
 * Generate schemas/webmcp.schema.json from the Zod source of truth.
 * Run `npm run build:schema` and commit the result so VSCode (Even Better TOML)
 * picks it up via the `# :schema` directive at the top of each template.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ConfigSchema } from "../src/config-types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const schema = zodToJsonSchema(ConfigSchema, {
    name: "WebMCPConfig",
    target: "jsonSchema7",
  });
  const out = path.join(ROOT, "schemas", "webmcp.schema.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(schema, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log(`[build-schema] wrote ${path.relative(ROOT, out)}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
