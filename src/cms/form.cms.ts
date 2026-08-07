// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const formCms = cmsResource({
  singular: "form",
  idPattern: /^[a-z][a-z0-9-]{0,62}$/,
  plural: "forms",
  schema: z.object({
    display_name: z.string().min(1).max(120).meta({
      description: "The form's name (appears in notification subjects).",
    }),
    notify_email: z.email().meta({
      description: "Where new submissions are announced.",
    }),
    redirect_url: z.url().optional().meta({
      description: "Where browsers land after a successful submit (303).",
    }),
    submit_key: z.string().optional().meta({
      description:
        "The publishable submit key (pk_…, baas/keys.md: identifies, not a secret — safe in public HTML). Minted at create; rotate by recreating the form.",
    }),
    created_by: z.string().optional().meta({
      description: "Denormalized owner-of-ancestor (baas/README.md §2).",
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
