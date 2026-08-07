import { readServices, resolveInstance, type ServiceInstance } from "hono-aep-cms";
import { createAuthn, registerAuthnKind, type Authn } from "hono-aep-auth";
import { createJobs, registerJobsKind, type JobHandler, type JobsEngine } from "hono-aep-jobs";
import {
  createNotifications,
  registerNotificationsKind,
  type Notifications,
} from "hono-aep-notifications";
import { registerConnectionsKind } from "hono-aep-connections";
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
