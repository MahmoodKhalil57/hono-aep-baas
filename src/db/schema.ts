/**
 * The app's drizzle schema surface: the generated resource tables
 * (`schema.gen.ts`, from `bun run db:schema`) plus every suite table set
 * riding the same database — auth, api keys, jobs, notifications.
 */
export * from "./schema.gen";
import { tables as generatedTables } from "./schema.gen";
export { user, session, account, verification, apiKey } from "hono-aep-auth";
import { apiKeyTables, authTables } from "hono-aep-auth";
export { operation } from "hono-aep-jobs";
import { jobsTables } from "hono-aep-jobs";
export { target, subscriber, message } from "hono-aep-notifications";
import { notificationTables } from "hono-aep-notifications";

export const tables = {
  ...generatedTables,
  ...jobsTables,
  ...notificationTables,
  ...apiKeyTables,
  ...authTables,
};
