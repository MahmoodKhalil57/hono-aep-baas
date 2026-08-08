import { aepApp } from "hono-aep";
import { mediaResource } from "hono-aep-media";
import { jsonRowsStorage } from "hono-aep-drizzle";
import { prefixStorage } from "unstorage";
import { db } from "../db/registry";
import { getBlobs } from "./blobs";

/**
 * Per-project media (media.md's TODO(saastarter) branch): metadata rides
 * the shared json_rows storage under the project scope — the same tenant
 * isolation as JIT collections — and bytes land in the blob seam behind a
 * `projects/{p}` key prefix (per-project bucket ISOLATION by prefix; a
 * physical bucket per project is an ops choice, not a contract change).
 * Upload policy is enforced at the dispatcher (app.ts): authenticated
 * upload, public download, owner-only mutation.
 */
const cache = new Map<string, ReturnType<typeof aepApp> | null>();

export const invalidateMedia = (projectId: string): void => {
  cache.delete(projectId);
};

export function projectMedia(projectId: string): ReturnType<typeof aepApp> | null {
  const cached = cache.get(projectId);
  if (cached !== undefined) return cached;
  const blobs = getBlobs();
  if (!blobs) {
    cache.set(projectId, null);
    return null; // no byte store installed (media disabled on this runtime)
  }
  const metadata = jsonRowsStorage({ db, scope: `projects/${projectId}` });
  const media = mediaResource({
    blobs: prefixStorage(blobs, `projects/${projectId}`),
    metadata,
    singular: "media-file",
    plural: "media",
    maxSizeBytes: 5 * 1024 * 1024, // 5 MB — avatars/product shots, not video
  });
  const app = aepApp({
    resources: [media.resource],
    storage: metadata,
    serviceName: "baas.hono-aep.dev",
    basePath: `/v1/projects/${projectId}`,
  });
  media.attach(app.app);
  cache.set(projectId, app);
  return app;
}
