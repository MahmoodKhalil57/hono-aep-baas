import { eq } from "drizzle-orm";
import { createAuthPool, type AuthPool, type AuthPoolConfig } from "hono-aep-auth";
import type { Principal } from "hono-aep";
import { db } from "../db/registry";
import { projects } from "../db/schema";

/**
 * Per-project END-USER auth pools (baas/auth-pools.md): a project whose
 * `auth_pool` config is present gets better-auth mounted at
 * /v1/projects/{p}/auth/* — bearer-first sessions over the shared,
 * tenancy-scoped pool tables. Cached like the JIT apps; the project's
 * hooks invalidate on config writes.
 */

const cache = new Map<string, AuthPool | null>();

export const invalidatePool = (projectId: string): void => {
  cache.delete(projectId);
};

const baseUrl = (): string =>
  process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

export async function projectPool(projectId: string): Promise<AuthPool | null> {
  const cached = cache.get(projectId);
  if (cached !== undefined) return cached;
  const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const config = rows[0]?.auth_pool as AuthPoolConfig | null | undefined;
  const pool = config
    ? createAuthPool({
        projectId,
        db,
        baseUrl: baseUrl(),
        basePath: `/v1/projects/${projectId}/auth`,
        config,
        env: process.env,
      })
    : null;
  cache.set(projectId, pool);
  return pool;
}

/** The end-user principal for a project's surfaces (JIT apps). */
export async function poolPrincipal(
  projectId: string,
  headers: Headers,
): Promise<Principal | null> {
  const pool = await projectPool(projectId);
  return pool ? pool.principal(headers) : null;
}
