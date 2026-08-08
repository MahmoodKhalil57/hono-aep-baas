import { and, eq } from "drizzle-orm";
import { createCommerce, type Commerce, type VariantLookup } from "hono-aep-commerce";
import { jsonRows } from "hono-aep-drizzle";
import type { EventEnvelope, Json } from "hono-aep";
import { db } from "../db/registry";
import { billing, eventSink, notifications } from "./services";

/**
 * Per-project commerce (baas/commerce.md): the variant lookup reads the
 * project's `products` hosted collection (a "variant" is a product slug
 * here — single-variant catalog); events re-scope under the project and
 * flow to the shared sink (jobs/webhooks) AND, for order_completed, the
 * notifications kind's confirmation email.
 */
const cache = new Map<string, Commerce>();

export function projectCommerce(projectId: string): Commerce {
  const cached = cache.get(projectId);
  if (cached) return cached;
  const scope = `projects/${projectId}`;

  // json_rows is defined against hono-aep-drizzle's drizzle copy; `db` against
  // the baas's. Structural cast (as the commerce package does) sidesteps the
  // two-copies nominal clash — runtime is one and the same table.
  const cdb = db as unknown as { select(): { from(t: unknown): { where(w: unknown): { limit(n: number): Promise<unknown[]> } } } };
  const col = jsonRows as unknown as Record<"scope" | "collection" | "id", never>;
  const variant: VariantLookup = async (v) => {
    const rows = (await cdb
      .select()
      .from(jsonRows)
      .where(and(eq(col.scope, scope), eq(col.collection, "product"), eq(col.id, v)))
      .limit(1)) as (typeof jsonRows.$inferSelect)[];
    if (!rows[0]) return null;
    const p = rows[0].data as { name?: string; price_cents?: number; category?: string };
    return { product_id: v, sku: v, name: p.name, category: p.category, price_cents: Number(p.price_cents ?? 0), inventory: null };
  };

  const onEvent = async (e: EventEnvelope): Promise<void> => {
    if (eventSink) await eventSink({ ...e, path: `${scope}/${e.path}`, type: `projects.${projectId}.${e.type}` });
    // order_completed → the derived, trustworthy consequences of a paid order.
    if (e.type === "order_completed") {
      const d = e.data as {
        order_id?: string; customer?: string; total_cents?: number;
        products?: { product_id?: string; name?: string; quantity?: number }[];
      };
      const products = d.products ?? [];
      // (1) Ownership: grant `owns:{product}` to the buyer for each line item
      //     — the entitlement the storefront's source-unlock authz gates on.
      //     A commerce order confers exactly what was bought (billing.md).
      if (billing && d.customer) {
        for (const item of products) {
          if (!item.product_id) continue;
          await billing
            .grantEntitlement({ principal: d.customer, entitlement: `owns:${item.product_id}`, source: `order:${d.order_id}:${item.product_id}` })
            .catch(() => ({ granted: [] }));
        }
      }
      // (2) The confirmation email (notifications kind).
      if (notifications) {
        const lines = products.map((i) => `${i.quantity}× ${i.name ?? "item"}`).join(", ");
        await notifications.notify({
          to: { email: "orders@saastarter2.example" },
          content: { subject: `Order ${d.order_id} confirmed`, body: `Paid: ${lines} — total ${(d.total_cents ?? 0) / 100} USD.` },
          channels: ["email"],
        }).catch(() => {});
      }
    }
  };

  const commerce = createCommerce({ db, variant, onEvent });
  cache.set(projectId, commerce);
  return commerce;
}
