import { delocalizeWrite, fallbackChain, isLocaleMap, localizeRow } from "hono-aep-cms";
import type { Json } from "hono-aep";
import type { JitProject } from "./jit-collections";

/**
 * The locale layer over JIT collections (cms/localization.md §3), applied
 * at the dispatcher so EVERY client — SPA, MCP, seed, studio — gets the
 * same semantics with zero app-level changes:
 *
 *  - reads with `?locale=<tag>` (default: the site default) resolve
 *    locale-map fields flat through the fallback chain
 *  - `?locale=all` returns raw maps (the authoring/export shape)
 *  - flat writes become single-locale maps; merge-patch then merges them
 *    into the stored map, and Apply (PUT) merges against the current row
 *    here so a one-locale edit never erases the other translations
 *
 * Known v1 limitation: `filter=` matches against the STORED maps, not the
 * resolved locale (spec §3's resolved-locale filtering is future work).
 */
export async function localizedJitFetch(
  jit: JitProject,
  request: Request,
  url: URL,
  pathBelowProject: string,
): Promise<Response> {
  const plural = pathBelowProject.split("/")[1]?.split(":")[0] ?? "";
  const fields = jit.localizedFields.get(plural) ?? [];
  const search = new URLSearchParams(url.search);
  const requested = search.get("locale");
  search.delete("locale"); // never leaks into the AEP app's param surface
  const query = search.toString() ? `?${search.toString()}` : "";
  const target = `${url.origin}${pathBelowProject}${query}`;

  // Non-localized collection or no locales config: transparent forward.
  if (fields.length === 0 || !jit.locales) {
    return jit.app.fetch(new Request(target, request));
  }

  const locale = requested ?? jit.locales.default;
  const chain = fallbackChain(locale === "all" ? jit.locales.default : locale, jit.locales);
  const method = request.method.toUpperCase();

  let forward: Request;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const body = (await request.clone().json().catch(() => null)) as Json | null;
    if (body === null) {
      forward = new Request(target, request);
    } else {
      let normalized = delocalizeWrite(body, fields, locale === "all" ? jit.locales.default : locale);
      if (method === "PUT") {
        // Apply is full-state: merge the incoming single-locale maps over
        // the stored maps so `PUT {title: "x"}?locale=ar` keeps the en text.
        const current = await jit.app.fetch(new Request(target, { headers: request.headers }));
        if (current.ok) {
          const stored = (await current.json()) as Json;
          for (const field of fields) {
            const incoming = normalized[field];
            const existing = stored[field];
            if (isLocaleMap(incoming) && isLocaleMap(existing)) {
              normalized = { ...normalized, [field]: { ...existing, ...incoming } };
            }
          }
        }
      }
      forward = new Request(target, {
        method,
        headers: request.headers,
        body: JSON.stringify(normalized),
      });
    }
  } else {
    forward = new Request(target, request);
  }

  const response = await jit.app.fetch(forward);
  if (locale === "all" || !response.ok) return response;
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("json")) return response;

  const payload = (await response.json()) as Json;
  const localized = Array.isArray(payload["results"])
    ? { ...payload, results: (payload["results"] as Json[]).map((row) => localizeRow(row, fields, chain)) }
    : localizeRow(payload, fields, chain);
  return new Response(JSON.stringify(localized), { status: response.status, headers: response.headers });
}
