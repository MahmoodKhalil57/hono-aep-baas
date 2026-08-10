import { eq } from "drizzle-orm";
import type { ScopeDelivery } from "hono-aep-notifications";
import { db } from "../db/registry";
import { projects } from "../db/schema";
import { projectEnv } from "./secrets";

/**
 * Per-project SERVICES (spec/services.md): a consumer declares which
 * driver runs each capability in `site.services`, and its KEYS live in
 * the project's secrets. The executor resolves per project — this is the
 * generalization of projectGateway (payment, already in secrets.ts) to
 * delivery and email. No new infra: same drivers, project-scoped config.
 *
 *   site.services = {
 *     payment:  { provider: "stripe" },              // keys: STRIPE_*
 *     delivery: { provider: "download" },
 *     email:    { provider: "resend", from: "…" },   // key: RESEND_API_KEY
 *   }
 */

export type ProjectServices = {
  payment?: { provider?: string };
  delivery?: { provider?: string };
  email?: { provider?: string; from?: string; replyTo?: string };
};

export async function projectServices(projectId: string): Promise<ProjectServices> {
  // Structural cast over the two-drizzle-copies nominal clash (same idiom
  // as commerce.ts/secrets.ts) — one and the same projects table at runtime.
  const rows = (await db.select().from(projects).where(eq(projects.id, projectId) as never).limit(1)) as {
    site: { services?: ProjectServices } | null;
  }[];
  return rows[0]?.site?.services ?? {};
}

/**
 * The notifications resolveScope (multi-tenancy): given a message's scope
 * `projects/{p}`, the project's declared email provider + its RESEND_API_KEY
 * from the project secrets — resolved at DELIVER time. Null → the operator's
 * static instance (back-compat for projects that declare nothing).
 */
export async function resolveEmailScope(scope: string): Promise<ScopeDelivery> {
  const match = /^projects\/([^/]+)$/.exec(scope);
  if (!match) return null;
  const projectId = match[1]!;
  const email = (await projectServices(projectId)).email;
  if (!email?.provider || email.provider === "local") return null;
  const env = await projectEnv(projectId);
  if (email.provider === "resend") {
    const apiKey = env["RESEND_API_KEY"];
    if (!apiKey) return null; // declared resend but no key → fall back, don't crash
    return {
      provider: "resend",
      config: {
        email: {
          apiKey, // the literal key from THIS project's secrets
          ...(email.from ? { from: email.from } : {}),
          ...(email.replyTo ? { replyTo: email.replyTo } : {}),
        },
      },
    };
  }
  return null; // other providers (ses/twilio) are PLANNED
}
