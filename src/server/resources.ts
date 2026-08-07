import { eq } from "drizzle-orm";
import { AepProblem, defineResource, type Json } from "hono-aep";
import { composable, resourceFromDocument } from "hono-aep-cms";
import { createApiKey } from "hono-aep-auth";
import { db } from "../db/registry";
import { collections, forms, projects } from "../db/schema";
import { projectCms } from "../cms/project.cms";
import { formCms } from "../cms/form.cms";
import { submissionCms } from "../cms/submission.cms";
import { collectionCms } from "../cms/collection.cms";
import { invalidateProject } from "./jit-collections";

/**
 * mizan-gpp's resource model (baas/README.md §2): tenancy IS the resource
 * tree. The declarative half lives in ../cms/*.cms.ts; this module is the
 * imperative half — the owner-of-ancestor hooks and the submit-key mint.
 */

const principalOf = (honoContext: import("hono").Context): { userId: string } | null =>
  ((honoContext.get as (key: string) => unknown)("aepPrincipal") as { userId: string } | null) ??
  null;

const forbidden = (detail: string): AepProblem =>
  new AepProblem({
    type: "PERMISSION_DENIED",
    status: 403,
    title: "The caller does not own the parent resource.",
    detail,
  });

/** `projects/{project}` — the tenancy root; created_by stamped server-side. */
export const project = defineResource({
  ...composable(projectCms),
  hooks: {
    beforeCreate: ({ data, honoContext }) => ({
      ...data,
      created_by: principalOf(honoContext)!.userId, // create policy is authenticated
    }),
    // Apply is sync's verb (baas/sync.md): same stamping, and replacing an
    // existing project requires owning it — the hook enforces what the
    // row-less apply policy cannot.
    beforeApply: ({ data, previous, honoContext }) => {
      const principal = principalOf(honoContext)!;
      if (previous && previous["created_by"] !== principal.userId) {
        throw forbidden("The project belongs to another account.");
      }
      return { ...data, created_by: (previous?.["created_by"] as string) ?? principal.userId };
    },
  },
});

/** `projects/{p}/forms/{form}` — owner checked against the parent; pk key minted. */
export const form = defineResource({
  ...composable(formCms),
  parent: project,
  hooks: {
    beforeCreate: async ({ data, parent, honoContext }) => {
      const principal = principalOf(honoContext)!;
      const projectId = parent.split("/")[1]!;
      const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!rows[0] || rows[0].created_by !== principal.userId) {
        throw forbidden(`${parent} is not owned by the caller.`);
      }
      // Publishable submit key (baas/keys.md): identifies, not a secret —
      // minted through the real key machinery, plaintext stored on the form
      // BY DESIGN (pk_ class), so the HTML embed is one copy-paste.
      const key = await createApiKey(db, {
        class: "publishable",
        name: `submit: ${String(data["display_name"] ?? "form")}`,
        userId: principal.userId,
        scopes: ["submissions:create"],
      });
      return { ...data, created_by: principal.userId, submit_key: key.plaintext };
    },
    // Sync applies forms by slug: first apply mints the key exactly like
    // create; re-applies PRESERVE the minted key and ownership (push twice
    // ≡ noop — sync.md §7), and foreign parents/rows stay 403.
    beforeApply: async ({ data, previous, parent, honoContext }) => {
      const principal = principalOf(honoContext)!;
      if (previous) {
        if (previous["created_by"] !== principal.userId) {
          throw forbidden("The form belongs to another account.");
        }
        return {
          ...data,
          created_by: previous["created_by"] as string,
          submit_key: previous["submit_key"] as string,
        };
      }
      const projectId = parent.split("/")[1]!;
      const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!rows[0] || rows[0].created_by !== principal.userId) {
        throw forbidden(`${parent} is not owned by the caller.`);
      }
      const key = await createApiKey(db, {
        class: "publishable",
        name: `submit: ${String(data["display_name"] ?? "form")}`,
        userId: principal.userId,
        scopes: ["submissions:create"],
      });
      return { ...data, created_by: principal.userId, submit_key: key.plaintext };
    },
  },
});

/** `…/submissions/{s}` — public create; owner denormalized from the form. */
export const submission = defineResource({
  ...composable(submissionCms),
  parent: form,
  hooks: {
    beforeCreate: async ({ data, parent }) => {
      const formId = parent.split("/")[3]!;
      const rows = await db.select().from(forms).where(eq(forms.id, formId)).limit(1);
      if (!rows[0]) {
        throw new AepProblem({
          type: "NOT_FOUND",
          status: 404,
          title: "The parent form does not exist.",
        });
      }
      return {
        ...data,
        verdict: (data["verdict"] as string | undefined) ?? "ham",
        created_by: rows[0].created_by ?? "",
      };
    },
  },
});

/**
 * Plurals the compiled surface owns — a JIT definition may not shadow
 * them (nested: forms/collections; top-level names blocked for sanity).
 */
const RESERVED_PLURALS = new Set([
  "projects",
  "forms",
  "submissions",
  "collections",
  "keys",
  "operations",
  "notifications",
]);

const invalidDefinition = (detail: string): AepProblem =>
  new AepProblem({
    type: "INVALID_ARGUMENT",
    status: 400,
    title: "The collection definition is invalid.",
    detail,
  });

async function validateDefinition(
  definition: Json,
  projectId: string,
  selfId: string | undefined,
): Promise<void> {
  const plural = String(definition["plural"] ?? "");
  if (RESERVED_PLURALS.has(plural)) {
    throw invalidDefinition(`plural '${plural}' is reserved by the platform surface.`);
  }
  if (definition["parent_collection"]) {
    throw invalidDefinition("nested JIT collections are not supported yet (top-level only).");
  }
  try {
    resourceFromDocument(definition); // the JIT gate: schema/policies/owner
  } catch (problem) {
    throw invalidDefinition(problem instanceof Error ? problem.message : String(problem));
  }
  const siblings = await db
    .select()
    .from(collections)
    .where(eq(collections.project_id, projectId));
  for (const sibling of siblings) {
    if (String(sibling.id) === selfId) continue;
    const other = sibling.definition as Json | null;
    if (other && String(other["plural"]) === plural) {
      throw invalidDefinition(`plural '${plural}' is already declared by collections/${sibling.id}.`);
    }
  }
}

/** `projects/{p}/collections/{slug}` — JIT definitions (execution-modes.md). */
export const collection = defineResource({
  ...composable(collectionCms),
  parent: project,
  hooks: {
    beforeCreate: async ({ data, parent, id, honoContext }) => {
      const principal = principalOf(honoContext)!;
      const projectId = parent.split("/")[1]!;
      const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!rows[0] || rows[0].created_by !== principal.userId) {
        throw forbidden(`${parent} is not owned by the caller.`);
      }
      await validateDefinition((data["definition"] as Json) ?? {}, projectId, id);
      return { ...data, created_by: principal.userId };
    },
    beforeApply: async ({ data, previous, parent, id, honoContext }) => {
      const principal = principalOf(honoContext)!;
      const projectId = parent.split("/")[1]!;
      if (previous) {
        if (previous["created_by"] !== principal.userId) {
          throw forbidden("The collection belongs to another account.");
        }
      } else {
        const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        if (!rows[0] || rows[0].created_by !== principal.userId) {
          throw forbidden(`${parent} is not owned by the caller.`);
        }
      }
      await validateDefinition((data["definition"] as Json) ?? {}, projectId, id);
      return { ...data, created_by: (previous?.["created_by"] as string) ?? principal.userId };
    },
    beforeUpdate: async ({ data, parent, id }) => {
      if (data["definition"] !== undefined) {
        await validateDefinition(data["definition"] as Json, parent.split("/")[1]!, id);
      }
      return data;
    },
    afterCreate: ({ parent }) => invalidateProject(parent.split("/")[1]!),
    afterUpdate: ({ parent }) => invalidateProject(parent.split("/")[1]!),
    afterApply: ({ parent }) => invalidateProject(parent.split("/")[1]!),
    afterDelete: ({ parent }) => invalidateProject(parent.split("/")[1]!),
  },
});
