import { defineResource } from "hono-aep";
import { composable } from "hono-aep-cms";
import { generateSqliteSchema } from "hono-aep-drizzle/generate";
import { projectCms } from "../src/cms/project.cms";
import { formCms } from "../src/cms/form.cms";
import { submissionCms } from "../src/cms/submission.cms";

/**
 * Regenerates src/db/schema.gen.ts from the DIALECT (not the composed
 * resources — those import the schema, and the generator must run before
 * it exists). The dialect is the source of truth either way.
 */
const project = defineResource({ ...composable(projectCms) });
const form = defineResource({ ...composable(formCms), parent: project });
const submission = defineResource({ ...composable(submissionCms), parent: form });

const schema = generateSqliteSchema({ resources: [project, form, submission] });
await Bun.write(new URL("../src/db/schema.gen.ts", import.meta.url), schema);
console.log("Wrote src/db/schema.gen.ts from the dialect.");
