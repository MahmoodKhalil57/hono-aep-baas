import { eq } from "drizzle-orm";
import type { JobHandler } from "hono-aep-jobs";
import type { Notifications } from "hono-aep-notifications";
import { db } from "../db/registry";
import { forms } from "../db/schema";

/** The imperative side of services/jobs.cms.json — handler types only. */
export function createJobHandlers(deps: {
  notifications: () => Notifications | null;
}): Record<string, JobHandler> {
  return {
    /**
     * Runs off `projects.*.forms.*.submissions.*.create`: announce the
     * submission to the form's notify address, and autorespond to the
     * submitter when `_replyto` was given (baas/forms.md §3). Spam-marked
     * submissions are stored but never announced.
     */
    "submission-intake": async (ctx) => {
      const event = (ctx.payload as {
        event?: { path?: string; data?: Record<string, unknown> };
      }).event;
      if (!event?.path || !event.data) throw new Error("submission-intake: event payload missing");
      if (event.data["verdict"] === "spam") {
        ctx.log(`submission ${event.path} marked spam — stored, not announced`);
        return { announced: false, verdict: "spam" };
      }
      const formId = event.path.split("/")[3]!;
      const row = (await db.select().from(forms).where(eq(forms.id, formId)).limit(1))[0];
      if (!row) throw new Error(`submission-intake: form '${formId}' not found`);

      const notifications = deps.notifications();
      if (!notifications) return { announced: false, reason: "notifications not configured" };

      const fields = (event.data["data"] as Record<string, unknown> | undefined) ?? {};
      const lines = Object.entries(fields)
        .map(([key, value]) => `**${key}**: ${String(value)}`)
        .join("\n\n");
      await notifications.notify({
        to: { email: row.notify_email },
        content: {
          subject: `New submission — ${row.display_name}`,
          body: `${lines}\n\n[Open the dashboard](/v1/${event.path})`,
        },
        channels: ["email"],
      });
      let autoresponded = false;
      const replyto = event.data["replyto"];
      if (typeof replyto === "string" && replyto) {
        await notifications.notify({
          to: { email: replyto },
          content: {
            subject: `We received your message — ${row.display_name}`,
            body: "Thanks! Your submission is in; we'll get back to you soon.",
          },
          channels: ["email"],
        });
        autoresponded = true;
      }
      ctx.log(`announced ${event.path} to ${row.notify_email}`);
      return { announced: true, to: row.notify_email, autoresponded };
    },
  };
}
