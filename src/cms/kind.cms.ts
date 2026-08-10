// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

/**
 * `projects/{project}/kinds/{kind}` (baas/kinds.md): a meta-resource this
 * project's CHILDREN will have — the runtime half of the layering that
 * built hono-aep-baas on hono-aep.
 *
 * Perfect symmetry with `collections/`, which declares resources for a
 * project's OWN app; `kinds/` declares them for its children's PLATFORM.
 * Same document shape, one level up — which is what makes a CMS that
 * builds a CMS teachable rather than a second system to learn.
 *
 * Shapes are free; capabilities are inherited (kinds.md §1). `bind` names
 * the platform behavior powering the shape, and it MUST be one the
 * declaring project already holds — enforced at the apply gate, so a layer
 * physically cannot hand a customer something it was not handed.
 */
export const kindCms = cmsResource({
  singular: "kind",
  idPattern: /^[a-z][a-z0-9-]{0,62}$/,
  plural: "kinds",
  schema: z.object({
    definition: z.record(z.string(), z.any()).meta({
      description:
        "The meta-resource document (kinds.md §2): singular/plural (the names a child sees), `bind` (the inherited capability powering it — REQUIRED), fields, states, transitions, policies, plus optional `constrain` and `defaults`. Validated on every write against the capabilities this project holds.",
    }),
    created_by: z.string().optional().meta({
      description: "Denormalized owner-of-ancestor.",
    }),
  }),
  owner: "created_by",
  methods: {
    apply: { policy: "authenticated" },
    create: { policy: "authenticated" },
    list: { policy: { owner: { field: "created_by" } } },
    get: { policy: { owner: { field: "created_by" } } },
    update: { policy: { owner: { field: "created_by" } } },
    delete: { policy: { owner: { field: "created_by" } } },
  },
});
