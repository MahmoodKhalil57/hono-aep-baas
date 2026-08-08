import "../db"; // opens bun:sqlite and installs the drizzle seam
import { createStorage } from "unstorage";
import fsLiteDriver from "unstorage/drivers/fs-lite";
import { setBlobs } from "./blobs";
import { readServices } from "hono-aep-cms";
import { setInstances } from "./runtime-config";

/**
 * The Bun entry: install the local db + the fs service instances BEFORE
 * the server body (./app) evaluates its service singletons, then serve.
 * The Worker (worker.ts) does the same with D1 + a bundled artifact.
 * Dynamic imports keep services.ts from evaluating before setInstances.
 */
const appRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
setInstances(readServices(appRoot));
setBlobs(createStorage({ driver: fsLiteDriver({ base: `${appRoot}/data/media` }) })); // media bytes (fs locally)

const { createHandler } = await import("./app");
const { jobs } = await import("./services");
const handle = createHandler();

jobs?.start(1000); // the local tick driver; Workers use scheduled()

// Local parity with Workers Static Assets: serve the built studio bundle
// (dist/studio-assets) when present — /studio resolves to studio.html the
// same way the edge's `assets` config does. Bun-only; app.ts stays fs-free.
const assetsDir = `${appRoot}/dist/studio-assets`;
async function serveStudioAsset(path: string): Promise<Response | null> {
  const candidate = path === "/studio" ? `${assetsDir}/studio.html` : `${assetsDir}${path}`;
  if (candidate.includes("..") || !/\.(html|js|css|map|ico|svg|png)$/.test(candidate)) return null;
  const file = Bun.file(candidate);
  return (await file.exists()) ? new Response(file) : null;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && (pathname === "/studio" || pathname.startsWith("/chunk-"))) {
      const asset = await serveStudioAsset(pathname);
      if (asset) return asset;
    }
    return handle(request);
  },
});
console.log(`🧾 mizan-gpp running at ${server.url}`);
