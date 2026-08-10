import { eq } from "drizzle-orm";
import { aepApp, defineResource, type EventEnvelope, type Json } from "hono-aep";
import { composable, localizationConfigSchema, resourceFromDocument, type LocalizationConfig } from "hono-aep-cms";
import { jsonRowsStorage } from "hono-aep-drizzle";
import { db } from "../db/registry";
import { collections, projects } from "../db/schema";
import { eventSink, principalFrom } from "./services";
import { poolPrincipal } from "./pools";
import { search } from "./services";
import { extractText } from "hono-aep-search";

/**
 * The JIT dispatcher (baas/collections.md §0-1): every project's declared
 * collections become a live aepApp over the shared json_rows table
 * (scope = the project path — tenant isolation is the storage key).
 * Cached per project; the collection resource's hooks invalidate on any
 * definition write, so Apply → live with no restart. Events are
 * re-scoped under the project so consumers subscribe with the full
 * grammar: `projects.<p>.<plural>.<id>.<verb>`.
 */

const cache = new Map<string, JitProject | null>();

export const invalidateProject = (projectId: string): void => {
  cache.delete(projectId);
};

const projectSink = (projectId: string) => {
  const sink = eventSink ?? (async () => {});
  return async (envelope: EventEnvelope): Promise<void> => {
    // Search index (derived state): the collection's rows are indexed on
    // write and removed on delete — scoped by project. The reindex-from-
    // storage job is the rebuild path (spec: the index is rebuildable).
    if (search) {
      const [collection, id] = envelope.path.split("/");
      const verb = envelope.type.split(".").pop();
      if (collection && id) {
        if (verb === "delete") await search.remove({ scope: `projects/${projectId}`, collection, id });
        else if (envelope.data)
          await search.index({ scope: `projects/${projectId}`, collection, id, text: extractText(envelope.data) });
      }
    }
    await sink({
      ...envelope,
      path: `projects/${projectId}/${envelope.path}`,
      type: `projects.${projectId}.${envelope.type}`,
    });
  };
};

export async function jitProjectApp(
  projectId: string,
): Promise<JitProject | null> {
  const cached = cache.get(projectId);
  if (cached !== undefined) return cached;

  const docs = await db
    .select()
    .from(collections)
    .where(eq(collections.project_id, projectId));
  if (docs.length === 0) {
    cache.set(projectId, null);
    return null;
  }
  // Resilience: one unbuildable definition (e.g. a row written before the
  // apply-gate ran the full pipeline) must NOT poison the project — every
  // sibling collection would 500 on every request. Skip it and log.
  const resources = docs.flatMap((doc) => {
    try {
      return [defineResource({ ...composable(resourceFromDocument(doc.definition as Json)) })];
    } catch (problem) {
      console.error(`jit: skipping collections/${doc.id} of ${projectId}:`, (problem as Error).message);
      return [];
    }
  });
  if (resources.length === 0) {
    cache.set(projectId, null);
    return null;
  }
  const sink = projectSink(projectId);
  const app = aepApp({
    resources,
    storage: jsonRowsStorage({ db, scope: `projects/${projectId}` }),
    serviceName: "baas.hono-aep.dev",
    basePath: `/v1/projects/${projectId}`,
    authorization: {
      // Builder session/key first; else the project's END-USER pool
      // (bearer) — both flow through the same policy vocabulary.
      principal: async (c) =>
        (await principalFrom(c)) ?? (await poolPrincipal(projectId, c.req.raw.headers)),
    },
    ...(sink ? { onEvent: sink } : {}),
  });

  // Localization metadata (cms/localization.md): which fields of which
  // plural are locale maps, plus the project's site.locales config — the
  // dispatcher's localize layer consumes both. Cached with the app;
  // collection AND project writes invalidate.
  const localizedFields = new Map<string, string[]>();
  for (const doc of docs) {
    const definition = doc.definition as { plural?: string; fields?: { name: string; localized?: boolean }[] };
    const names = (definition.fields ?? []).filter((field) => field.localized === true).map((field) => field.name);
    if (definition.plural && names.length > 0) localizedFields.set(definition.plural, names);
  }
  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const site = projectRows[0]?.site as { locales?: unknown } | null;
  const parsedLocales = localizationConfigSchema.safeParse(site?.locales);
  const enriched: JitProject = {
    ...app,
    localizedFields,
    locales: parsedLocales.success ? parsedLocales.data : null,
  };
  cache.set(projectId, enriched);
  return enriched;
}

export type JitProject = ReturnType<typeof aepApp> & {
  localizedFields: Map<string, string[]>;
  locales: LocalizationConfig | null;
};

/** Compiled child plurals the dispatcher must never intercept. */
export const COMPILED_CHILD_PLURALS = new Set(["forms", "collections", "domains", "kinds", "themes", "pages", "blocks", "auth", "media", "deliveries", "openapi.json", "mcp"]);
