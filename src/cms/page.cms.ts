// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const pageCms = cmsResource({
  singular: "page",
  idPattern: /^[a-z][a-z0-9-]{0,62}$/,
  plural: "pages",
  schema: z.object({
    title: z.string().min(1).max(160),
    data: z.record(z.string(), z.any()).meta({
      description: "The Puck document ({content: [...], root: {...}}) — rendered by hono-aep-blocks CmsPage.",
    }),
    seo: z.record(z.string(), z.any()).optional().meta({
      description: "Per-page head overrides (site.md; reified at build for static consumers).",
    }),
    created_by: z.string().optional(),
  }),
  owner: "created_by",
  methods: {
    apply: { policy: "authenticated" },
    create: { policy: "authenticated" },
    // Site content: the read surface is PUBLIC — the static SPA fetches it.
    list: true,
    get: true,
    update: { policy: { owner: { field: "created_by" } } },
    delete: { policy: { owner: { field: "created_by" } } },
  },
});
