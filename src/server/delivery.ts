import { and, eq } from "drizzle-orm";
import {
  createDeliveryService,
  downloadDriver,
  manualDriver,
  type DeliveryService,
  type DeliveryView,
} from "hono-aep-delivery";
import { jsonRows } from "hono-aep-drizzle";
import { db } from "../db/registry";

/**
 * Per-project delivery (spec/delivery.md §3): the download driver's claim
 * paths carry the project; onStatus couples delivery to the ORDER machine
 * — a terminal-successful delivery that covers the order walks it
 * fulfilled → shipped → delivered (virtual goods deliver themselves).
 */
const cache = new Map<string, DeliveryService>();

export function projectDelivery(projectId: string): DeliveryService {
  const cached = cache.get(projectId);
  if (cached) return cached;
  const service = createDeliveryService({
    db,
    secret: process.env["BETTER_AUTH_SECRET"] ?? "delivery-claims-dev",
    drivers: [
      downloadDriver({
        claimPath: (deliveryId, item) => `/v1/projects/${projectId}/deliveries/${deliveryId}:claim?item=${item}`,
      }),
      manualDriver(),
    ],
    onStatus: async (view: DeliveryView) => {
      if (view.status !== "delivered") return;
      // The commerce coupling: walk the order forward as far as legal.
      const { projectCommerce } = await import("./commerce");
      const commerce = projectCommerce(projectId);
      for (const to of ["fulfilled", "shipped", "delivered"] as const) {
        try {
          await commerce.advance({ orderId: view.orderId, to });
        } catch {
          break; // already past, or not yet paid — the machine stays honest
        }
      }
    },
  });
  cache.set(projectId, service);
  return service;
}

/** The `file` a product row carries (media id) — resolved at delivery time. */
export async function productFile(projectId: string, productId: string): Promise<string | null> {
  const scope = `projects/${projectId}`;
  const cdb = db as unknown as { select(): { from(t: unknown): { where(w: unknown): { limit(n: number): Promise<unknown[]> } } } };
  const col = jsonRows as unknown as Record<"scope" | "collection" | "id", never>;
  const rows = (await cdb
    .select()
    .from(jsonRows)
    .where(and(eq(col.scope, scope), eq(col.collection, "product"), eq(col.id, productId)))
    .limit(1)) as (typeof jsonRows.$inferSelect)[];
  const file = (rows[0]?.data as { file?: string } | undefined)?.file;
  return typeof file === "string" && file.length > 0 ? file : null;
}
