// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const blockCms = cmsResource({
  singular: "block",
  idPattern: /^[a-z][a-z0-9-]{0,62}$/,
  plural: "blocks",
  schema: z.object({
    title: z.string().max(160).optional().meta({
      description: "Editor-facing label; never rendered.",
    }),
    data: z.record(z.string(), z.any()).meta({
      description: "The Puck FRAGMENT ({content: [...]}) — a section rendered as-is by CmsBlock inside the consumer's own routes.",
    }),
    created_by: z.string().optional(),
  }),
  owner: "created_by",
  methods: {
    apply: { policy: "authenticated" },
    create: { policy: "authenticated" },
    list: true,
    get: true,
    update: { policy: { owner: { field: "created_by" } } },
    delete: { policy: { owner: { field: "created_by" } } },
  },
});
