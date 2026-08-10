import { eq } from "drizzle-orm";
import { db } from "../db/registry";
import { kinds, projects } from "../db/schema";
import type { Json } from "hono-aep";

/**
 * The capability catalog and the narrowing law (baas/kinds.md §3, §6).
 *
 * Shapes are free; capabilities are inherited. A `kind` document invents a
 * shape and BINDS it to a platform behavior — and a project may only bind
 * what it already holds:
 *
 *   holds(root)  = CATALOG
 *   holds(child) = { bind(k) : k ∈ kinds(parent(child)) }
 *
 * Each layer can rename, redact and constrain, never widen, so safety is
 * structural rather than policed: a layer cannot hand a customer a
 * capability it was not handed. Attenuation is monotone, so the chain
 * terminates — infinite depth is permitted, infinite authority is not.
 */

/**
 * The bindable behaviors, each already implemented and already backed by a
 * Cloudflare product. Adding one is a PLATFORM change (code + spec) — the
 * deliberate boundary between composing what exists and extending the
 * engine (kinds.md §1, §6).
 */
export const CATALOG = new Set([
  "collection", // a document becomes a live tenant-scoped REST resource (D1)
  "theme", // canonicalized CSS served per project (D1)
  "page", // structured documents + renderer (D1)
  "block", // reusable document fragments (D1)
  "form", // public submit endpoint + minted pk_ key (D1)
  "domain", // verified host → surface routing (Workers custom domains)
  "media", // blob upload/serve (R2)
  "search", // indexed query + embeddings (Workers AI)
  "jobs", // queued async work (Queues / cron)
  "notifications", // multi-channel delivery
  "auth_pool", // end-user identity for a project's own customers
  "secrets", // per-project encrypted values
  "billing",
  "gateway",
  "delivery",
  "connections",
  "flags",
  // The recursive one: granting it makes a customer a platform in turn,
  // withholding it makes them a leaf (kinds.md §6).
  "project",
]);

/** The kinds a project declares for its CHILDREN. */
export async function declaredKinds(projectId: string): Promise<Json[]> {
  const rows = (await db
    .select()
    .from(kinds)
    .where(eq(kinds.project_id as never, projectId as never))) as unknown as {
    definition?: Json | null;
  }[];
  return rows.map((row) => (row.definition ?? {}) as Json).filter((d) => Object.keys(d).length > 0);
}

/**
 * The capabilities a project may bind. A project's platform is defined by
 * its PARENT's kinds; the root holds the whole catalog.
 *
 * Absent kinds on the parent ⇒ inherit unchanged (kinds.md §5, the beginner
 * clause): a builder who never opens the file gets today's behavior, so the
 * concept stays invisible until someone deliberately shapes a platform.
 */
export async function holds(projectId: string): Promise<Set<string>> {
  const rows = (await db
    .select()
    .from(projects)
    .where(eq(projects.id as never, projectId as never))
    .limit(1)) as unknown as { created_by?: string | null }[];
  const parent = /^pool:([^:]+):/.exec(String(rows[0]?.created_by ?? ""))?.[1];
  if (!parent) return CATALOG; // a root-owned project holds everything
  const parentKinds = await declaredKinds(parent);
  if (parentKinds.length === 0) return CATALOG; // §5: inherit unchanged
  return new Set(parentKinds.map((k) => String(k["bind"] ?? "")).filter(Boolean));
}
