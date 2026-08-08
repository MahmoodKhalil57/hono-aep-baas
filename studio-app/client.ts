import { aepClient } from "hono-aep/client";

/**
 * The one /v1 client instance: the tabs import it directly (full generic
 * surface incl. apply/call), and app.tsx hands the SAME instance to
 * AepUiProvider so composites share its ETag/If-Match cache.
 */
export const v1 = aepClient({ base: "/v1" });
