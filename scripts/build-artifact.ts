import { readServices } from "hono-aep-cms";

/** Bundle the fs service instances for the Worker (no fs at the edge). */
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const instances = readServices(root);
await Bun.write(new URL("../dist/services.json", import.meta.url), JSON.stringify(instances, null, 2));
console.log(`Wrote dist/services.json (${instances.length} instances).`);
