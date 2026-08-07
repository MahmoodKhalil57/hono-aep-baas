// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const collectionCms = cmsResource({
  singular: "collection",
  idPattern: /^[a-z][a-z0-9-]{0,62}$/,
  plural: "collections",
  schema: z.object({
    definition: z.record(z.string(), z.any()).meta({
      description:
        "The resource document (cms/execution-modes.md JIT form): singular/plural, fields, states, transitions, policies, owner. Validated by resourceFromDocument on every write.",
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
