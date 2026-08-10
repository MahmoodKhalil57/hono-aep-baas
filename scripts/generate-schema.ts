import { defineResource } from "hono-aep";
import { composable } from "hono-aep-cms";
import { generateSqliteSchema } from "hono-aep-drizzle/generate";
import { projectCms } from "../src/cms/project.cms";
import { formCms } from "../src/cms/form.cms";
import { submissionCms } from "../src/cms/submission.cms";
import { collectionCms } from "../src/cms/collection.cms";
import { domainCms } from "../src/cms/domain.cms";
import { themeCms } from "../src/cms/theme.cms";
import { pageCms } from "../src/cms/page.cms";
import { blockCms } from "../src/cms/block.cms";

/**
 * Regenerates src/db/schema.gen.ts from the DIALECT (not the composed
 * resources — those import the schema, and the generator must run before
 * it exists). The dialect is the source of truth either way.
 */
const project = defineResource({ ...composable(projectCms) });
const form = defineResource({ ...composable(formCms), parent: project });
const submission = defineResource({ ...composable(submissionCms), parent: form });
const collection = defineResource({ ...composable(collectionCms), parent: project });
const domain = defineResource({ ...composable(domainCms), parent: project });
const theme = defineResource({ ...composable(themeCms), parent: project });
const page = defineResource({ ...composable(pageCms), parent: project });
const block = defineResource({ ...composable(blockCms), parent: project });

const schema = generateSqliteSchema({ resources: [project, form, submission, collection, domain, theme, page, block] });
await Bun.write(new URL("../src/db/schema.gen.ts", import.meta.url), schema);
console.log("Wrote src/db/schema.gen.ts from the dialect.");
