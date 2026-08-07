// Managed by hono-aep-cms — the visually buildable dialect.
import { z } from "zod";
import { cmsResource } from "hono-aep-cms";

export const submissionCms = cmsResource({
  singular: "submission",
  plural: "submissions",
  schema: z.object({
    data: z.record(z.string(), z.any()).meta({
      description: "The submitted fields (reserved `_` control fields already stripped).",
    }),
    replyto: z.email().optional().meta({
      description: "The submitter's address (from `_replyto`) — the autoresponder Target.",
    }),
    verdict: z.enum(["ham", "spam", "unverified"]).optional().meta({
      description: "Spam-posture outcome (forms.md §2) — recorded, never silently dropped.",
    }),
    created_by: z.string().optional().meta({
      description: "Denormalized owner-of-ancestor (the form's owner).",
    }),
  }),
  owner: "created_by",
  methods: {
    apply: false,
    // THE web3forms move: creation is public; everything else is the owner's.
    create: true,
    list: { policy: { owner: { field: "created_by" } } },
    get: { policy: { owner: { field: "created_by" } } },
    update: false,
    delete: { policy: { owner: { field: "created_by" } } },
  },
});
