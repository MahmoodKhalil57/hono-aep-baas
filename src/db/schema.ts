/**
 * The app's drizzle schema surface: the generated resource tables
 * (`schema.gen.ts`, from `bun run db:schema`) plus every suite table set
 * riding the same database — auth, api keys, jobs, notifications.
 *
 * Every table MUST be exported by name, not merely spread into `tables`:
 * drizzle-kit discovers tables through the module's exports, so one that is
 * only in the map is silently absent from generated migrations — which is how
 * billing_customer, delivery and pool_two_factor came to exist in production
 * with no migration describing them.
 */
export * from "./schema.gen";
import { tables as generatedTables } from "./schema.gen";
export { user, session, account, verification, apiKey } from "hono-aep-auth";
export { poolUser, poolSession, poolAccount, poolVerification, poolTwoFactor } from "hono-aep-auth";
import { apiKeyTables, authTables, poolTables } from "hono-aep-auth";
export { operation } from "hono-aep-jobs";
import { jobsTables } from "hono-aep-jobs";
export { target, subscriber, message } from "hono-aep-notifications";
import { notificationTables } from "hono-aep-notifications";
// JIT collection rows (cms/execution-modes.md §3) ride it too.
export { jsonRows } from "hono-aep-drizzle";
import { jsonRowsTables } from "hono-aep-drizzle";
export { entitlementGrant, billingCustomer } from "hono-aep-billing";
import { billingTables } from "hono-aep-billing";
export { searchDocument } from "hono-aep-search";
import { searchTables } from "hono-aep-search";
export { cart, order } from "hono-aep-commerce";
import { commerceTables } from "hono-aep-commerce";
export { delivery } from "hono-aep-delivery";
import { deliveryTables } from "hono-aep-delivery";

export const tables = {
  ...generatedTables,
  ...jobsTables,
  ...notificationTables,
  ...jsonRowsTables,
  ...billingTables,
  ...searchTables,
  ...commerceTables,
  ...deliveryTables,
  ...apiKeyTables,
  ...poolTables,
  ...authTables,
};
