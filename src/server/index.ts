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

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: (request) => handle(request),
});
console.log(`🧾 mizan-gpp running at ${server.url}`);
