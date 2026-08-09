import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

/**
 * The $schema enforcer (sync.md §6 / seed.md §7): walk a config or seed
 * repo, require every .json file to declare a `$schema`, fetch each
 * schema once (they live on the baas — /v1/schemas/{kind}.json and
 * /v1/projects/{p}/schemas/rows/{plural}.json), and validate. Editors
 * get the same URLs for live autocomplete; this makes it CI-able.
 *
 *   bun bin/validate.ts --dir ../saastarter2/hono-aep-baas-config
 *   bun bin/validate.ts --dir ../saastarter2/hono-aep-baas-idempotent-seed
 */

const dir = process.argv[process.argv.indexOf("--dir") + 1];
if (!dir || dir.startsWith("--")) {
  console.error("Usage: bun bin/validate.ts --dir <repo>");
  process.exit(2);
}

const files: string[] = [];
const walk = (at: string): void => {
  for (const name of readdirSync(at)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(at, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".json")) files.push(full);
  }
};
walk(dir);

const ajv = new Ajv2020({ strict: false, allErrors: true, loadSchema: (uri) => loadSchema(uri) as never });
addFormats(ajv as never);
const fetched = new Map<string, Promise<Record<string, unknown>>>();
const loadSchema = (url: string): Promise<Record<string, unknown>> => {
  let promise = fetched.get(url);
  if (!promise) {
    promise = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
      return (await response.json()) as Record<string, unknown>;
    });
    fetched.set(url, promise);
  }
  return promise;
};

let failures = 0;
for (const file of files.sort()) {
  const label = relative(dir, file);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (problem) {
    console.error(`✗ ${label}: invalid JSON — ${(problem as Error).message}`);
    failures += 1;
    continue;
  }
  const schemaUrl = body.$schema;
  if (typeof schemaUrl !== "string") {
    console.error(`✗ ${label}: missing $schema`);
    failures += 1;
    continue;
  }
  try {
    const schema = await loadSchema(schemaUrl);
    const validate = ajv.getSchema(schemaUrl) ?? (await ajv.compileAsync({ ...schema, $id: schemaUrl }));
    if (validate(body)) console.log(`✓ ${label}`);
    else {
      failures += 1;
      console.error(`✗ ${label}:`);
      for (const error of validate.errors ?? []) {
        console.error(`    ${error.instancePath || "/"} ${error.message}`);
      }
    }
  } catch (problem) {
    failures += 1;
    console.error(`✗ ${label}: ${(problem as Error).message}`);
  }
}
console.log(`\n${files.length - failures}/${files.length} valid`);
process.exit(failures ? 1 : 0);
