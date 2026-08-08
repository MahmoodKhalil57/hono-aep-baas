import { readServices, resolveInstance, type ServiceInstance } from "hono-aep-cms";
import { createAuthn, registerAuthnKind, type Authn } from "hono-aep-auth";
import { createJobs, registerJobsKind, type JobHandler, type JobsEngine } from "hono-aep-jobs";
import {
  createNotifications,
  registerNotificationsKind,
  type Notifications,
} from "hono-aep-notifications";
import { createConnectionsConsumer, registerConnectionsKind, type ConnectionsConsumer } from "hono-aep-connections";
import { composeSinks, type EventSink } from "hono-aep";
import { keyPrincipal, type Principal } from "hono-aep-auth";
import { db } from "../db/registry";
import { createJobHandlers } from "./jobs";

/** mizan-gpp's installed kinds — same wiring shape as richPetShop. */
registerAuthnKind();
registerJobsKind();
registerNotificationsKind();
registerConnectionsKind();

const appRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const instances: ServiceInstance[] = readServices(appRoot);

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
  return (
    (await authn.principal(c.req.raw.headers)) ??
    (await keyPrincipal(db, c.req.header("Authorization")))
  );
}

/** The resource-event sink shared by every app instance (jobs consumes). */
export const eventSink: EventSink | null = jobs ? composeSinks(jobs.eventConsumer()) : null;

/** The inbound webhook consumer over all connections instances (per project
 *  instances are read at receive-time; this reads the app-level set). */
export const connectionsConsumer: ConnectionsConsumer | null = jobs
  ? createConnectionsConsumer({ instances, enqueue: jobs.enqueue, env: process.env })
  : null;
