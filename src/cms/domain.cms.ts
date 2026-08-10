// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

/**
 * `projects/{project}/domains/{host}` (baas/domains.md): a surface is
 * reachable at its owner's origin, so the host is a RESOURCE with a
 * lifecycle — declaring one proves nothing, and an unproven host must never
 * route (that is what a takeover looks like).
 *
 * The id IS the host, so a claim is naturally unique per project; global
 * uniqueness across projects is enforced at the apply gate.
 */
export const domainCms = cmsResource({
  singular: "domain",
  // A lowercase FQDN label chain — no scheme, no port, no path, no
  // trailing dot. Deliberately narrower than DNS allows.
  idPattern: /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-)){1,10}$/,
  plural: "domains",
  states: ["PENDING", "ACTIVE", "FAILED"],
  initialState: "PENDING",
  schema: z.object({
    kind: z.enum(["api", "site"]).meta({
      description:
        "`api` makes this host the surface origin — openapi servers[], {BASE}/mcp, studio/admin, auth callbacks. `site` is the frontend origin used for absolute links, OG cards and redirects.",
    }),
    challenge: z.string().optional().meta({
      description:
        "OUTPUT-ONLY. Publish as TXT at `_hono-aep-challenge.{host}`, then call `:verify`. Proof of control is what authorizes routing.",
      "x-ui": { control: "readonly" },
    }),
    verified_time: z.string().optional().meta({
      description: "OUTPUT-ONLY. When the challenge last resolved.",
      "x-ui": { control: "readonly" },
    }),
    last_error: z.string().optional().meta({
      description: "OUTPUT-ONLY. Why the most recent `:verify` did not pass.",
      "x-ui": { control: "readonly" },
    }),
    created_by: z.string().optional().meta({
      description: "Denormalized owner-of-ancestor.",
    }),
  }),
  owner: "created_by",
  transitions: {
    // The verb is `:verify` (below); this is the state edge it drives.
    activate: { from: ["PENDING", "FAILED"], to: "ACTIVE", description: "Proof accepted — the host may route." },
    suspend: { from: ["ACTIVE"], to: "PENDING", description: "Proof lapsed — routing stops." },
  },
  methods: {
    apply: { policy: "authenticated" },
    create: { policy: "authenticated" },
    list: { policy: { owner: { field: "created_by" } } },
    get: { policy: { owner: { field: "created_by" } } },
    update: { policy: { owner: { field: "created_by" } } },
    delete: { policy: { owner: { field: "created_by" } } },
  },
});
