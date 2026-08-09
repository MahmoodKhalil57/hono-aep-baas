/**
 * SHIM — the sync client moved to customPackages/hono-aep-baas-cli
 * (src/sync.ts) so layer-3 users get it from npm (`baas sync …`). This
 * re-export keeps the operator ritual (`bun bin/sync.ts …`) and the
 * baas test imports working unchanged.
 */
export * from "hono-aep-baas-cli/sync";
import { main } from "hono-aep-baas-cli/sync";
if (import.meta.main) await main();
