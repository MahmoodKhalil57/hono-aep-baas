// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const projectCms = cmsResource({
  singular: "project",
  idPattern: /^[a-z][a-z0-9-]{0,62}$/,
  plural: "projects",
  schema: z.object({
    display_name: z.string().min(1).max(120).meta({
      description: "The project's name.",
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
