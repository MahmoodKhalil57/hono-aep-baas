/** SHIM — moved to hono-aep-baas-cli (src/validate.ts); see bin/sync.ts. */
export * from "hono-aep-baas-cli/validate";
import { main } from "hono-aep-baas-cli/validate";
if (import.meta.main) await main();
