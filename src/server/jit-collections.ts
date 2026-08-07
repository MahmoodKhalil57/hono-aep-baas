import { eq } from "drizzle-orm";
import { aepApp, defineResource, type EventEnvelope, type Json } from "hono-aep";
import { composable, resourceFromDocument } from "hono-aep-cms";
import { jsonRowsStorage } from "hono-aep-drizzle";
import { db } from "../db/registry";
import { collections } from "../db/schema";
import { eventSink, principalFrom } from "./services";

/**
 * The JIT dispatcher (baas/collections.md §0-1): every project's declared
 * collections become a live aepApp over the shared json_rows table
 * (scope = the project path — tenant isolation is the storage key).
 * Cached per project; the collection resource's hooks invalidate on any
 * definition write, so Apply → live with no restart. Events are
 * re-scoped under the project so consumers subscribe with the full
 * grammar: `projects.<p>.<plural>.<id>.<verb>`.
 */

const cache = new Map<string, ReturnType<typeof aepApp> | null>();

export const invalidateProject = (projectId: string): void => {
  cache.delete(projectId);
};

const projectSink = (projectId: string) => {
  const sink = eventSink;
  if (!sink) return undefined;
  return async (envelope: EventEnvelope): Promise<void> => {
    await sink({
      ...envelope,
      path: `projects/${projectId}/${envelope.path}`,
      type: `projects.${projectId}.${envelope.type}`,
    });
  };
};

export async function jitProjectApp(
  projectId: string,
): Promise<ReturnType<typeof aepApp> | null> {
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
  const resources = docs.map((doc) =>
    defineResource({ ...composable(resourceFromDocument(doc.definition as Json)) }),
  );
  const sink = projectSink(projectId);
  const app = aepApp({
    resources,
    storage: jsonRowsStorage({ db, scope: `projects/${projectId}` }),
    serviceName: "baas.hono-aep.dev",
    basePath: `/v1/projects/${projectId}`,
    authorization: { principal: principalFrom },
    ...(sink ? { onEvent: sink } : {}),
  });
  cache.set(projectId, app);
  return app;
}

/** Compiled child plurals the dispatcher must never intercept. */
export const COMPILED_CHILD_PLURALS = new Set(["forms", "collections", "themes", "pages", "blocks"]);
