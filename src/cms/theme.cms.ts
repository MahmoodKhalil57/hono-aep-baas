// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const themeCms = cmsResource({
  singular: "theme",
  idPattern: /^[a-z][a-z0-9-]{0,62}$/,
  plural: "themes",
  schema: z.object({
    css: z.string().min(1).meta({
      description:
        "The theme document (.cms.css form): `:root { --tokens }` + `.dark { … }`. Canonicalized on every write (round-trip law); tweakcn output pastes straight in.",
      "x-ui": { control: "textarea" },
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
