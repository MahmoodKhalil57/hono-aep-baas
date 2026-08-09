/** SHIM — moved to hono-aep-baas-cli (src/seed.ts); see bin/sync.ts. */
export * from "hono-aep-baas-cli/seed";
import { main } from "hono-aep-baas-cli/seed";
if (import.meta.main) await main();
