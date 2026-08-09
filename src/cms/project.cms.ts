// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const projectCms = cmsResource({
  singular: "project",
  idPattern: /^[a-z0-9][a-z0-9-]{0,62}$/, // platform-minted UUIDs may lead with a digit (issue #2) — the minter and the validator must agree
  plural: "projects",
  schema: z.object({
    display_name: z.string().min(1).max(120).meta({
      description: "The project's name.",
    }),
    auth_pool: z.record(z.string(), z.any()).optional().meta({
      description:
        "END-USER auth pool (baas/auth-pools.md): presence enables /v1/projects/{p}/auth/* (better-auth, bearer-first). Config: {emailPassword?{enabled}, session?{ttlSeconds}}.",
    }),
    site: z.record(z.string(), z.any()).optional().meta({
      description:
        "Site config for the consumer frontend (baas/site.md §2): {url, description?, locale?, name?, app?{shortName,display,shortcuts,…}} — feeds the reified sitemap/robots/llms/manifest artifacts.",
    }),
    created_by: z.string().optional().meta({
      description: "The owning principal (set by the server, never the client).",
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
