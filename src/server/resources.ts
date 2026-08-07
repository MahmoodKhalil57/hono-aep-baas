import { eq } from "drizzle-orm";
import { AepProblem, defineResource } from "hono-aep";
import { composable } from "hono-aep-cms";
import { createApiKey } from "hono-aep-auth";
import { db } from "../db/registry";
import { forms, projects } from "../db/schema";
import { projectCms } from "../cms/project.cms";
import { formCms } from "../cms/form.cms";
import { submissionCms } from "../cms/submission.cms";

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
