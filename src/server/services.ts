import { resolveInstance, type ServiceInstance } from "hono-aep-cms";
import { createAuthn, registerAuthnKind, type Authn } from "hono-aep-auth";
import { createJobs, registerJobsKind, type JobHandler, type JobsEngine } from "hono-aep-jobs";
import {
  createNotifications,
  registerNotificationsKind,
  type Notifications,
} from "hono-aep-notifications";
import { createConnectionsConsumer, registerConnectionsKind, type ConnectionsConsumer } from "hono-aep-connections";
import { createGateway, stripeGatewayDriver } from "hono-aep-gateway";
import { createBilling, registerBillingKind, type Billing } from "hono-aep-billing";
import { createFlags, registerFlagsKind, type Flags } from "hono-aep-flags";
import { createSearch, registerSearchKind, type Search } from "hono-aep-search";
import { composeSinks, type EventSink } from "hono-aep";
import { keyPrincipal, type Principal } from "hono-aep-auth";
import { db } from "../db/registry";
import { createJobHandlers } from "./jobs";

/** mizan-gpp's installed kinds — same wiring shape as richPetShop. */
registerAuthnKind();
registerJobsKind();
registerNotificationsKind();
registerConnectionsKind();
registerBillingKind();
registerFlagsKind();
registerSearchKind();

import { getInstances } from "./runtime-config";
import { getEmbedder } from "./embed";
export const instances: ServiceInstance[] = getInstances();

let notificationsRef: Notifications | null = null;
const handlers: Record<string, JobHandler> = createJobHandlers({
  notifications: () => notificationsRef,
});

export const authn: Authn | null = (() => {
  const instance = resolveInstance(instances, "authn");
  if (!instance) return null;
  return createAuthn({
    instance,
    db,
    baseUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
    env: process.env,
  });
})();

export const jobs: JobsEngine | null = (() => {
  const instance = resolveInstance(instances, "jobs");
  if (!instance) return null;
  return createJobs({ instance, db, handlers });
})();

export const notifications: Notifications | null = (() => {
  const instance = resolveInstance(instances, "notifications");
  if (!instance || !jobs) return null;
  const created = createNotifications({ instance, db, enqueue: jobs.enqueue, env: process.env });
  notificationsRef = created;
  Object.assign(handlers, created.jobHandlers());
  return created;
})();

/** Session-or-key principal — one resolver for the compiled AND JIT apps. */
export async function principalFrom(c: import("hono").Context): Promise<Principal | null> {
  if (!authn) return null;
  const base =
    (await authn.principal(c.req.raw.headers)) ??
    (await keyPrincipal(db, c.req.header("Authorization")));
  return withEntitlements(base);
}

/** The resource-event sink shared by every app instance (jobs consumes). */
export const eventSink: EventSink | null = jobs ? composeSinks(jobs.eventConsumer()) : null;

/** The inbound webhook consumer over all connections instances (per project
 *  instances are read at receive-time; this reads the app-level set). */
export const connectionsConsumer: ConnectionsConsumer | null = jobs
  ? createConnectionsConsumer({ instances, enqueue: jobs.enqueue, env: process.env })
  : null;

export const billing: Billing | null = (() => {
  const instance = resolveInstance(instances, "billing");
  return instance ? createBilling({ instance, db, env: process.env }) : null;
})();

/**
 * The payment gateway (gateway.md): the NEUTRAL driver behind embedded
 * in-page checkout. Constructed from env — present only when the stripe
 * keys are; commerce degrades to hosted mode without it. Swapping the
 * provider = swapping the driver HERE; nothing downstream changes.
 */
export const gateway = (() => {
  const secretKey = process.env["STRIPE_SECRET_KEY"];
  const publishableKey = process.env["STRIPE_PUBLISHABLE_KEY"] ?? process.env["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"];
  if (!secretKey || !publishableKey) return null;
  return createGateway(
    stripeGatewayDriver({
      secretKey,
      publishableKey,
      ...(process.env["STRIPE_WEBHOOK_SECRET"] ? { webhookSecret: process.env["STRIPE_WEBHOOK_SECRET"] } : {}),
    }),
  );
})();

/**
 * Principal resolution with ENTITLEMENTS merged (billing populates the
 * authz `entitlement` predicate). Every surface's principal chain calls
 * this, so a policied `{entitlement:["pro"]}` gates on real grants.
 */
export async function withEntitlements(principal: Principal | null): Promise<Principal | null> {
  if (!principal || !billing) return principal;
  const entitlements = await billing.entitlementsFor(principal.userId);
  return entitlements.length > 0 ? { ...principal, entitlements } : principal;
}

export const flags: Flags | null = (() => {
  const instance = resolveInstance(instances, "flags");
  return instance ? createFlags({ instance }) : null;
})();

export const search: Search | null = (() => {
  const instance = resolveInstance(instances, "search");
  if (!instance) return null;
  const embed = getEmbedder();
  return createSearch({ instance, db, ...(embed ? { embed } : {}) });
})();
