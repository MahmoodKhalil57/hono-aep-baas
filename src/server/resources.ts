import { eq } from "drizzle-orm";
import { AepProblem, defineResource, type Json } from "hono-aep";
import { composable, parseThemeCss, printThemeCss, resourceFromDocument } from "hono-aep-cms";
import { createApiKey } from "hono-aep-auth";
import { db } from "../db/registry";
import { collections, domains, forms, projects } from "../db/schema";
import { projectCms } from "../cms/project.cms";
import { formCms } from "../cms/form.cms";
import { submissionCms } from "../cms/submission.cms";
import { collectionCms } from "../cms/collection.cms";
import { domainCms } from "../cms/domain.cms";
import { themeCms } from "../cms/theme.cms";
import { pageCms } from "../cms/page.cms";
import { blockCms } from "../cms/block.cms";
import { invalidateProject } from "./jit-collections";
import { invalidatePool } from "./pools";

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

/* Project writes can change auth_pool AND site.locales — drop both caches. */
const projectAfter = ({ id }: { id: string }): void => {
  invalidatePool(id);
  invalidateProject(id);
};

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
    afterCreate: projectAfter,
    afterUpdate: projectAfter,
    afterApply: projectAfter,
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
  "domains",
  "media",
  "deliveries",
  "themes",
  "pages",
  "blocks",
  "auth",
  "webhooks",
  "billing",
  "flags",
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
    // The FULL serving pipeline is the gate: resourceFromDocument alone
    // misses defineResource's own invariants (kebab-case names per
    // AEP-122, …), and a definition that only fails at serve time would
    // poison the whole project's JIT app on every request.
    defineResource({ ...composable(resourceFromDocument(definition)) });
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

/** Canonicalize a theme document; reject css that carries no tokens. */
function canonicalThemeCss(slug: string, css: string): string {
  const parsed = parseThemeCss(slug, css);
  if (Object.keys(parsed.light).length === 0 && Object.keys(parsed.dark).length === 0) {
    throw new AepProblem({
      type: "INVALID_ARGUMENT",
      status: 400,
      title: "Not a theme document.",
      detail: "Expected `:root { --token: value; … }` (and optionally `.dark { … }`).",
    });
  }
  return printThemeCss(parsed);
}

/** `projects/{p}/themes/{slug}` — hosted tweakcn documents (baas/site.md §1). */
/**
 * `projects/{p}/domains/{host}` (baas/domains.md): the host a surface
 * answers at. Declaring is not owning, so a row lands in PENDING with a
 * minted challenge and routes NOTHING until `:verify` proves control of the
 * zone. Everything downstream is already base-relative (surface.md §1), so
 * activation is all it takes for the domain to reach openapi, MCP, the
 * studio, the admin and the site assets.
 */
const CHALLENGE_LABEL = "_hono-aep-challenge";

/** A host belongs to exactly one project: first ACTIVE claim wins. */
const assertHostUnclaimed = async (host: string, parent: string): Promise<void> => {
  const projectId = parent.split("/")[1]!;
  const rows = (await db.select().from(domains).where(eq(domains.id as never, host as never))) as unknown as {
    id: string; project_id?: string | null; state?: string | null;
  }[];
  const taken = rows.find((row) => row.project_id !== projectId && row.state === "ACTIVE");
  if (taken) {
    throw new AepProblem({
      type: "ALREADY_EXISTS", status: 409,
      title: "The host is claimed by another project.",
      detail: `${host} is already ACTIVE elsewhere. Release it there first.`,
    });
  }
};

/**
 * Resolve the challenge TXT over DoH — Workers have no raw DNS. Bounded:
 * `:verify` is a user-facing call, and an unreachable or slow resolver must
 * fail closed (no proof) rather than hang the request.
 */
const readChallengeTxt = async (host: string): Promise<string[]> => {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`${CHALLENGE_LABEL}.${host}`)}&type=TXT`,
      { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
    return (body.Answer ?? [])
      .filter((answer) => answer.type === 16)
      .map((answer) => answer.data.trim().replace(/^"|"$/g, ""));
  } catch {
    return [];
  }
};

export const domain = defineResource({
  ...composable(domainCms),
  parent: project,
  hooks: {
    beforeCreate: async ({ data, parent, id, honoContext }) => {
      const principal = principalOf(honoContext)!;
      const rows = await db.select().from(projects).where(eq(projects.id, parent.split("/")[1]!)).limit(1);
      if (!rows[0] || rows[0].created_by !== principal.userId) {
        throw forbidden(`${parent} is not owned by the caller.`);
      }
      await assertHostUnclaimed(String(id ?? ""), parent);
      return {
        ...data,
        // Output-only: the client never chooses its own proof.
        challenge: `hono-aep-domain-verification=${crypto.randomUUID()}`,
        verified_time: undefined,
        last_error: undefined,
        created_by: principal.userId,
      };
    },
    /**
     * The proof fields are OUTPUT-ONLY, and an ordinary update is the back
     * door that would otherwise let a caller choose its own challenge (and
     * so aim verification at a TXT record it can already publish). Pin them
     * to what the server last wrote.
     */
    beforeUpdate: ({ data, previous }) => ({
      ...data,
      challenge: previous?.["challenge"],
      verified_time: previous?.["verified_time"],
      last_error: previous?.["last_error"],
      created_by: previous?.["created_by"],
    }),
    beforeApply: async ({ data, previous, parent, id, honoContext }) => {
      const principal = principalOf(honoContext)!;
      if (previous && previous["created_by"] !== principal.userId) {
        throw forbidden("The domain belongs to another account.");
      }
      if (!previous) {
        const rows = await db.select().from(projects).where(eq(projects.id, parent.split("/")[1]!)).limit(1);
        if (!rows[0] || rows[0].created_by !== principal.userId) {
          throw forbidden(`${parent} is not owned by the caller.`);
        }
        await assertHostUnclaimed(String(id ?? ""), parent);
      }
      // Re-applying MUST NOT let a caller hand itself a challenge, a
      // verification time, or (via config) an ACTIVE state.
      return {
        ...data,
        challenge: (previous?.["challenge"] as string) ?? `hono-aep-domain-verification=${crypto.randomUUID()}`,
        verified_time: previous?.["verified_time"],
        last_error: previous?.["last_error"],
        created_by: (previous?.["created_by"] as string) ?? principal.userId,
      };
    },
  },
  customMethods: [
    {
      verb: "verify",
      description:
        "Resolve the challenge TXT at `_hono-aep-challenge.{host}` and, on a match, activate the domain so it begins routing. Publish the record first; re-run after DNS propagates.",
      handler: async ({ resource, id, save }) => {
        const expected = String(resource["challenge"] ?? "");
        const found = await readChallengeTxt(id);
        if (!expected) {
          return await save({ state: "FAILED", last_error: "No challenge on the record; recreate the domain." });
        }
        if (!found.includes(expected)) {
          // A tool error the model can act on, not a protocol failure.
          return await save({
            state: resource["state"] === "ACTIVE" ? "PENDING" : "PENDING",
            last_error:
              found.length === 0
                ? `No TXT record at ${CHALLENGE_LABEL}.${id}. Publish the challenge value, then retry.`
                : `TXT at ${CHALLENGE_LABEL}.${id} did not match the challenge (${found.length} record(s) found).`,
          });
        }
        return await save({
          state: "ACTIVE",
          verified_time: new Date().toISOString(),
          last_error: undefined,
        });
      },
    },
  ],
});

export const theme = defineResource({
  ...composable(themeCms),
  parent: project,
  hooks: {
    beforeCreate: async ({ data, parent, id, honoContext }) => {
      const principal = principalOf(honoContext)!;
      const rows = await db.select().from(projects).where(eq(projects.id, parent.split("/")[1]!)).limit(1);
      if (!rows[0] || rows[0].created_by !== principal.userId) {
        throw forbidden(`${parent} is not owned by the caller.`);
      }
      return {
        ...data,
        css: canonicalThemeCss(id ?? "theme", String(data["css"] ?? "")),
        created_by: principal.userId,
      };
    },
    beforeApply: async ({ data, previous, parent, id, honoContext }) => {
      const principal = principalOf(honoContext)!;
      if (previous) {
        if (previous["created_by"] !== principal.userId) {
          throw forbidden("The theme belongs to another account.");
        }
      } else {
        const rows = await db.select().from(projects).where(eq(projects.id, parent.split("/")[1]!)).limit(1);
        if (!rows[0] || rows[0].created_by !== principal.userId) {
          throw forbidden(`${parent} is not owned by the caller.`);
        }
      }
      return {
        ...data,
        css: canonicalThemeCss(id ?? "theme", String(data["css"] ?? "")),
        created_by: (previous?.["created_by"] as string) ?? principal.userId,
      };
    },
    beforeUpdate: ({ data, id }) =>
      data["css"] !== undefined
        ? { ...data, css: canonicalThemeCss(id ?? "theme", String(data["css"])) }
        : data,
  },
});

/** Puck document guard: {content: [...]} — the shape both renderers need. */
function assertPuckDocument(data: unknown, fragment: boolean): void {
  const doc = data as { content?: unknown } | null;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.content)) {
    throw new AepProblem({
      type: "INVALID_ARGUMENT",
      status: 400,
      title: fragment ? "Not a Puck fragment." : "Not a Puck document.",
      detail: "Expected `data.content` to be an array of blocks.",
    });
  }
}

const siteDocHooks = (fragment: boolean) => ({
  beforeCreate: async ({ data, parent, honoContext }: { data: Record<string, unknown>; parent: string; honoContext: import("hono").Context }) => {
    const principal = principalOf(honoContext)!;
    const rows = await db.select().from(projects).where(eq(projects.id, parent.split("/")[1]!)).limit(1);
    if (!rows[0] || rows[0].created_by !== principal.userId) {
      throw forbidden(`${parent} is not owned by the caller.`);
    }
    assertPuckDocument(data["data"], fragment);
    return { ...data, created_by: principal.userId };
  },
  beforeApply: async ({ data, previous, parent, honoContext }: { data: Record<string, unknown>; previous?: Record<string, unknown>; parent: string; honoContext: import("hono").Context }) => {
    const principal = principalOf(honoContext)!;
    if (previous) {
      if (previous["created_by"] !== principal.userId) {
        throw forbidden("The document belongs to another account.");
      }
    } else {
      const rows = await db.select().from(projects).where(eq(projects.id, parent.split("/")[1]!)).limit(1);
      if (!rows[0] || rows[0].created_by !== principal.userId) {
        throw forbidden(`${parent} is not owned by the caller.`);
      }
    }
    assertPuckDocument(data["data"], fragment);
    return { ...data, created_by: (previous?.["created_by"] as string) ?? principal.userId };
  },
  beforeUpdate: ({ data }: { data: Record<string, unknown> }) => {
    if (data["data"] !== undefined) assertPuckDocument(data["data"], fragment);
    return data;
  },
});

/** `projects/{p}/pages/{slug}` — hosted Puck pages (baas/site.md §1). */
export const page = defineResource({
  ...composable(pageCms),
  parent: project,
  hooks: siteDocHooks(false),
});

/** `projects/{p}/blocks/{slug}` — hosted Puck fragments (site.md §1). */
export const block = defineResource({
  ...composable(blockCms),
  parent: project,
  hooks: siteDocHooks(true),
});
