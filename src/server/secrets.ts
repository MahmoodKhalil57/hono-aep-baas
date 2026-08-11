import { and, eq } from "drizzle-orm";
import { jsonRows } from "hono-aep-drizzle";
import { createGateway, stripeGatewayDriver } from "hono-aep-gateway";
import { db } from "../db/registry";

/**
 * Per-project secrets (spec/secrets.md): a WRITE-ONLY value store in
 * json_rows (scope projects/{p}, reserved collection __secrets — no
 * migration, invisible to JIT/search). projectEnv() is the resolution
 * ladder consumers use: project secret over worker env. Writes bump a
 * generation counter so cached consumers (pools, gateways) rebuild.
 */

const COLLECTION = "__secrets";
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

// Structural cast over the two-drizzle-copies nominal clash (the same
// idiom commerce.ts uses) — runtime is one and the same table.
const rows = jsonRows as unknown as Record<"scope" | "collection" | "parent" | "id", never>;
type Row = { id: string; data: { digest?: string; value?: string } | null; update_time?: string | null };

const scopeOf = (projectId: string) => `projects/${projectId}`;

export async function digestOf(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listSecrets(projectId: string): Promise<{ name: string; digest: string }[]> {
  const found = (await db
    .select()
    .from(jsonRows)
    .where(and(eq(rows.scope, scopeOf(projectId) as never), eq(rows.collection, COLLECTION as never)))) as Row[];
  return found
    .map((row) => ({ name: row.id, digest: row.data?.digest ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function setSecret(projectId: string, name: string, value: string): Promise<{ name: string; digest: string }> {
  const digest = await digestOf(value);
  const where = and(
    eq(rows.scope, scopeOf(projectId) as never),
    eq(rows.collection, COLLECTION as never),
    eq(rows.id, name as never),
  );
  const existing = (await db.select().from(jsonRows).where(where)) as Row[];
  const now = new Date().toISOString();
  if (existing.length) {
    await db.update(jsonRows).set({ data: { value, digest }, updateTime: now } as never).where(where);
  } else {
    await db.insert(jsonRows).values({
      scope: scopeOf(projectId), collection: COLLECTION, parent: "", id: name,
      data: { value, digest }, createTime: now, updateTime: now,
    } as never);
  }
  bump(projectId);
  return { name, digest };
}

export async function deleteSecret(projectId: string, name: string): Promise<void> {
  await db.delete(jsonRows).where(and(
    eq(rows.scope, scopeOf(projectId) as never),
    eq(rows.collection, COLLECTION as never),
    eq(rows.id, name as never),
  ));
  bump(projectId);
}

/**
 * ONLY the project's own secrets — no worker-env layer (spec/secrets.md §2a).
 *
 * `projectEnv` deliberately falls back to the operator's environment, which
 * is right for a SHARED capability: a project with no Stripe key of its own
 * uses the operator's gateway, and that is the documented ladder.
 *
 * It is exactly wrong for a BYOK credential. There, a miss must read as "this
 * project has not connected an account", never as "use ours" — otherwise a
 * tenant's provisioning silently runs with the PLATFORM's token against the
 * PLATFORM's account. `CLOUDFLARE_API_TOKEN` and `GITHUB_TOKEN` are also
 * among the likeliest names to already exist in a deploy environment, so the
 * collision is probable rather than theoretical.
 */
export async function projectSecrets(projectId: string): Promise<Record<string, string>> {
  const found = (await db
    .select()
    .from(jsonRows)
    .where(and(eq(rows.scope, scopeOf(projectId) as never), eq(rows.collection, COLLECTION as never)))) as Row[];
  const own: Record<string, string> = {};
  for (const row of found) if (typeof row.data?.value === "string") own[row.id] = row.data.value;
  return own;
}

/**
 * The env for config whose EnvRef NAMES are chosen by the TENANT.
 *
 * `auth_pool` is owner-writable free-form config (project.cms.ts), and the
 * pool resolves `{"$env": NAME}` out of whatever map it is handed. Handing it
 * `projectEnv` — which layers project secrets over `{...process.env}` — makes
 * the operator's entire environment readable by name: a project that sets its
 * Google `clientId` to `{"$env": "STRIPE_SECRET_KEY"}` gets that value echoed
 * straight back in the provider's authorize URL, because `client_id` is a
 * query parameter. Verified end to end in env-exfiltration.test.ts.
 *
 * So the worker env contributes ONLY the names below — the operator's
 * deliberate shared fallbacks (secrets.md §2) — and everything else resolves
 * from the project's own secrets or not at all. An unresolved EnvRef already
 * means "provider off" downstream, which is the safe direction.
 */
const SHARED_FALLBACK = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

export async function tenantConfigEnv(projectId: string): Promise<Record<string, string | undefined>> {
  const shared: Record<string, string | undefined> = {};
  for (const name of SHARED_FALLBACK) shared[name] = process.env[name];
  return { ...shared, ...(await projectSecrets(projectId)) };
}

/**
 * The resolution ladder (spec §2): project secrets over the worker env.
 *
 * ONLY for config whose EnvRef names the OPERATOR controls. Anywhere a tenant
 * picks the name, use `tenantConfigEnv`; anywhere a credential is BYOK, use
 * `projectSecrets`.
 */
export async function projectEnv(projectId: string): Promise<Record<string, string | undefined>> {
  const found = (await db
    .select()
    .from(jsonRows)
    .where(and(eq(rows.scope, scopeOf(projectId) as never), eq(rows.collection, COLLECTION as never)))) as Row[];
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const row of found) if (typeof row.data?.value === "string") merged[row.id] = row.data.value;
  return merged;
}

/** Cache-busting for per-project consumers: pools/gateways key on this. */
const generations = new Map<string, number>();
const bump = (projectId: string): void => void generations.set(projectId, generation(projectId) + 1);
export const generation = (projectId: string): number => generations.get(projectId) ?? 0;

/**
 * The project-scoped payment gateway (spec §2): built from the PROJECT's
 * own STRIPE_* secrets — money flows to the project owner's Stripe. Null
 * when unset; callers fall back to the operator's global gateway.
 */
type Gateway = ReturnType<typeof createGateway>;
const gatewayCache = new Map<string, { generation: number; gateway: Gateway | null }>();
export async function projectGateway(projectId: string): Promise<Gateway | null> {
  const at = generation(projectId);
  const cached = gatewayCache.get(projectId);
  if (cached && cached.generation === at) return cached.gateway;
  const found = (await db
    .select()
    .from(jsonRows)
    .where(and(eq(rows.scope, scopeOf(projectId) as never), eq(rows.collection, COLLECTION as never)))) as Row[];
  const values = Object.fromEntries(found.map((row) => [row.id, row.data?.value]));
  const secretKey = values["STRIPE_SECRET_KEY"];
  const publishableKey = values["STRIPE_PUBLISHABLE_KEY"];
  const gateway =
    typeof secretKey === "string" && typeof publishableKey === "string"
      ? createGateway(stripeGatewayDriver({
          secretKey,
          publishableKey,
          ...(typeof values["STRIPE_WEBHOOK_SECRET"] === "string" ? { webhookSecret: values["STRIPE_WEBHOOK_SECRET"] } : {}),
        }))
      : null;
  gatewayCache.set(projectId, { generation: at, gateway });
  return gateway;
}
