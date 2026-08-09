import { eq } from "drizzle-orm";
import { createAuthPool, type AuthPool, type AuthPoolConfig } from "hono-aep-auth";
import type { Principal } from "hono-aep";
import { db } from "../db/registry";
import { projects } from "../db/schema";
import { notifications, withEntitlements } from "./services";
import type { PoolEmailSender } from "hono-aep-auth";

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
        // §1.7: lifecycle mail rides the project's notifications instance —
        // one delivery pipeline (jobs, providers, report cards), no bespoke
        // mailer. Absent instance → the pool logs (dev-safe).
        ...(notifications
          ? {
              sendEmail: (async ({ to, subject, body }) => {
                await notifications!.notify({
                  to: { email: to },
                  content: { subject, body },
                  channels: ["email"],
                });
              }) satisfies PoolEmailSender,
            }
          : {}),
        // Guest → account upgrade (commerce.md §3a.3): re-parent every
        // principal-keyed row the guest accumulated — cart, orders,
        // wishlist (and any owner-scoped JIT rows), entitlement grants,
        // the billing customer mapping. An upgrade that orphaned a paid
        // order would fail the spec's conformance clause.
        onLinkAccount: async ({ anonymousUserId, newUserId }) => {
          const from = `pool:${projectId}:${anonymousUserId}`;
          const to = `pool:${projectId}:${newUserId}`;
          const scope = `projects/${projectId}`;
          const { commerceTables } = await import("hono-aep-commerce");
          const { billingTables } = await import("hono-aep-billing");
          const { jsonRows } = await import("hono-aep-drizzle");
          const { and, eq: equals } = await import("drizzle-orm");
          const udb = db as unknown as {
            update(t: unknown): { set(v: unknown): { where(w: unknown): Promise<unknown> } };
            select(): { from(t: unknown): { where(w: unknown): Promise<unknown[]> } };
          };
          const cartCols = commerceTables.cart as unknown as Record<"scope" | "customer", never>;
          const orderCols = commerceTables.order as unknown as Record<"scope" | "customer", never>;
          await udb.update(commerceTables.cart).set({ customer: to }).where(and(equals(cartCols.scope, scope), equals(cartCols.customer, from)));
          await udb.update(commerceTables.order).set({ customer: to }).where(and(equals(orderCols.scope, scope), equals(orderCols.customer, from)));
          const grantCols = billingTables.entitlementGrant as unknown as Record<"principal", never>;
          await udb.update(billingTables.entitlementGrant).set({ principal: to }).where(equals(grantCols.principal, from));
          const customerCols = billingTables.billingCustomer as unknown as Record<"principal", never>;
          await udb.update(billingTables.billingCustomer).set({ principal: to }).where(equals(customerCols.principal, from));
          // Owner-scoped JIT rows (wishlist et al): rewrite data.created_by.
          const rowCols = jsonRows as unknown as Record<"scope", never>;
          const rows = (await udb.select().from(jsonRows).where(equals(rowCols.scope, scope))) as {
            collection: string; parent: string; id: string; data: Record<string, unknown>;
          }[];
          for (const row of rows) {
            if (row.data?.["created_by"] === from) {
              const idCols = jsonRows as unknown as Record<"scope" | "collection" | "parent" | "id", never>;
              await udb
                .update(jsonRows)
                .set({ data: { ...row.data, created_by: to } })
                .where(and(equals(idCols.scope, scope), equals(idCols.collection, row.collection), equals(idCols.parent, row.parent), equals(idCols.id, row.id)));
            }
          }
        },
        // The resolution ladder (spec/secrets.md §2): the project's own
        // secrets shadow the worker env — self-serve OAuth credentials.
        env: await (await import("./secrets")).projectEnv(projectId),
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
  return pool ? withEntitlements(await pool.principal(headers)) : null;
}
