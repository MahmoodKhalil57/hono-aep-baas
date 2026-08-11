// mizan-gpp server body — runtime-neutral (Bun + Cloudflare Workers).
// The Bun entry (index.ts) and the Worker (worker.ts) each install their
// db + service instances, then import THIS for the fetch handler.
import { eq } from "drizzle-orm";
import { aepApp, attachMcp, openApiDocument, type Json } from "hono-aep";
import { createApiKey, keyPrincipal } from "hono-aep-auth";
import { createHealthProbes, startWideEvent } from "hono-aep-observability";
import { fallbackChain, localizationConfigSchema, localizeRow, parseThemeCss, renderThemeCss } from "hono-aep-cms";
import { contextOf } from "hono-aep-flags";
import { projectCommerce } from "./commerce";
import { db } from "../db/registry";
import { collections, domains, forms, projects, tables, themes } from "../db/schema";
import { drizzleAepStorage } from "hono-aep-drizzle";
import { block, collection, domain, form, kind, page, project, submission, theme } from "./resources";
import { COMPILED_CHILD_PLURALS, jitProjectApp } from "./jit-collections";
import { studioHtml } from "./studio-page";
import { projectPool } from "./pools";
import { authn, billing, connectionsConsumer, eventSink, flags, gateway, jobs, notifications, principalFrom, search } from "./services";

/**
 * mizan-gpp — forms-as-a-service (baas/spec/). The whole server: the AEP
 * surface over the dialect, auth, the /submit/{key} static-HTML alias
 * (forms.md §1), health probes (agents.md §2), and the suite services.
 * Minimal LoC by design: everything generic lives in the packages.
 */

const aep = aepApp({
  resources: [
    project,
    form,
    submission,
    collection,
    domain,
    kind,
    theme,
    page,
    block,
    ...(jobs ? [jobs.resource({ policy: "authenticated" })] : []),
    ...(notifications ? [notifications.feedResource()] : []),
  ],
  storage: drizzleAepStorage({ db, tables, resources: [project, form, submission, collection, domain, kind, theme, page, block] }),
  serviceName: "baas.hono-aep.dev",
  basePath: "/v1",
  ...(authn ? { authorization: { principal: principalFrom } } : {}),
  ...(eventSink ? { onEvent: eventSink } : {}),
});
attachMcp(aep, { name: "mizan-gpp" });

/**
 * Nested surfaces (surface.md §1.1): the CMS-on-CMS rewrite unwraps
 * /v1/projects/{a}/projects/{b}/** to the flat /v1/projects/{b}/**, so the
 * caller-visible base is destroyed BY DESIGN — that is what makes nesting
 * free. The ancestor chain carries it alongside, so every generator can stay
 * base-relative (the recursion law) at any depth.
 *
 * INTERNAL state: stripped from every ingress request and appended only by
 * the ownership-verified rewrite. A caller able to declare its own ancestry
 * could mint documents advertising a surface it does not own.
 */
const ANCESTORS_HEADER = "x-aep-ancestors";

const ancestorsOf = (request: Request): string[] =>
  (request.headers.get(ANCESTORS_HEADER) ?? "").split(",").filter(Boolean);

/**
 * A custom origin (domains.md §3) is the third spelling of BASE. When the
 * request arrived on one, the base is that origin with an EMPTY path prefix
 * — plus any nesting reached under it — so generators keep advertising the
 * alias the caller actually used.
 */
const DOMAIN_HEADER = "x-aep-domain";

/** The caller-visible project base — nesting is a pure prefix. */
const surfaceBase = (request: Request, projectId: string): string => {
  const nesting = ancestorsOf(request).map((id) => `/projects/${id}`).join("");
  const onDomain = request.headers.get(DOMAIN_HEADER);
  // On a custom origin the surface IS the root; deeper projects still nest
  // under it, but the domain's own project contributes no path segment.
  if (onDomain) return nesting ? `${nesting}/projects/${projectId}` : "";
  return `/v1${nesting}/projects/${projectId}`;
};

const stripInternal = (request: Request): Request => {
  if (!request.headers.has(ANCESTORS_HEADER) && !request.headers.has(DOMAIN_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(ANCESTORS_HEADER);
  headers.delete(DOMAIN_HEADER);
  return new Request(request, { headers });
};

/**
 * Host → surface (domains.md §3). DNS cannot express this mapping: it has
 * no paths, and workers.dev answers only for its own name. So the worker
 * resolves it — an ACTIVE `api` domain rewrites the request onto that
 * project's platform path, and everything downstream is unchanged.
 *
 * Only ACTIVE routes. A PENDING host must NOT fall through to the platform
 * surface: serving an unverified name is what a takeover looks like.
 */
const domainSurface = async (host: string): Promise<{ project: string } | "unverified" | null> => {
  if (!host) return null;
  const rows = (await db
    .select()
    .from(domains)
    .where(eq(domains.id as never, host.toLowerCase().split(":")[0]! as never))) as unknown as {
    project_id?: string | null; state?: string | null; kind?: string | null;
  }[];
  const active = rows.find((row) => row.state === "ACTIVE" && row.kind === "api");
  if (active?.project_id) return { project: active.project_id };
  // §3.1: a host that has been CLAIMED but not proven must not fall through
  // to the platform surface. Serving anything on an unverified name is how
  // a takeover is made to look legitimate.
  return rows.length > 0 ? "unverified" : null;
};


const probes = createHealthProbes({
  version: "0.1.0",
  checks: [
    {
      name: "database",
      probe: async () => {
        await db.select().from(forms).limit(1);
      },
    },
  ],
});

/**
 * Cross-origin contract (site.md §2a, normative): wildcard `*`
 * WITHOUT Allow-Credentials — public reads and Bearer flows work from any
 * static origin (GitHub Pages is the reference host); session cookies
 * stay same-origin by construction. ETag/If-Match exposed for sync and
 * optimistic UI.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "ETag, X-Request-Id, set-auth-token, set-two-factor-token",
} as const;

const preflight = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, X-Request-Id, two-factor-token",
      "Access-Control-Max-Age": "86400",
    },
  });

const corsify = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
};

const RESERVED = new Set(["_redirect", "_botcheck", "_replyto"]);

/**
 * The founding constraint (baas/forms.md §1): one attribute on a static
 * HTML form. Accepts form-encoded, multipart, and JSON; strips reserved
 * `_` control fields; honeypot accepts-and-marks (never tips off the
 * bot); browsers get a 303, JSON callers get the resource.
 */
async function submit(request: Request, key: string): Promise<Response> {
  const row = (await db.select().from(forms).where(eq(forms.submit_key, key)).limit(1))[0];
  if (!row) return Response.json({ title: "Unknown submit key." }, { status: 404 });

  const contentType = request.headers.get("Content-Type") ?? "";
  let fields: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    fields = (await request.json()) as Record<string, unknown>;
  } else {
    const parsed = await request.formData();
    for (const [name, value] of parsed.entries()) {
      fields[name] = typeof value === "string" ? value : (value as File).name; // attachments: phase 2
    }
  }
  const control: Record<string, string> = {};
  for (const name of RESERVED) {
    if (typeof fields[name] === "string") control[name] = fields[name] as string;
    delete fields[name];
  }

  const body = {
    data: fields,
    ...(control["_replyto"] ? { replyto: control["_replyto"] } : {}),
    ...(control["_botcheck"] ? { verdict: "spam" } : {}),
  };
  const projectPath = `projects/${row.project_id}/forms/${row.id}`;
  const created = await aep.app.request(`/${projectPath}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (created.status !== 201) return created;

  const redirect = control["_redirect"] ?? row.redirect_url ?? null;
  const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
  if (!wantsJson && redirect) {
    return new Response(null, { status: 303, headers: { Location: redirect } });
  }
  if (!wantsJson) {
    return new Response("Thanks — your submission is in.", {
      status: 200,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  }
  return created;
}

let documentPromise: Promise<Record<string, unknown>> | undefined;


// ---------------------------------------------------------------------------
// The runtime-neutral fetch handler: the same route table for both runtimes.
// ---------------------------------------------------------------------------

export function createHandler(): (request: Request) => Promise<Response> {
  const routes = {

    "/": () =>
      Response.json({
        name: "mizan-gpp",
        studio: "/studio",
        docs: "/v1/openapi.json",
        mcp: "/v1/mcp",
        health: "/healthz",
        spec: "https://hono-aep.dev/spec/2026-08/baas/product",
      }),
    "/api/auth/*": (request: Request) =>
      authn
        ? authn.handler(request)
        : Promise.resolve(Response.json({ title: "authn not configured" }, { status: 503 })),
    // The sync-key bootstrap (sync.md §5): a signed-in builder mints their
    // sk_ secret key here; the full keys management resource is TODO(baas)
    // (keys.md §3). Plaintext returned once — hashed at rest from here on.
    "/v1/keys:mint": {
      POST: async (request: Request) => {
        const principal = authn ? await authn.principal(request.headers) : null;
        if (!principal) return Response.json({ title: "Sign in to mint a key." }, { status: 401 });
        const minted = await createApiKey(db, {
          class: "secret",
          name: "sync",
          userId: principal.userId,
          scopes: ["*"],
        });
        return Response.json({ plaintext: minted.plaintext, display: minted.display });
      },
    },
    "/v1/openapi.json": async () => {
      documentPromise ??= openApiDocument(aep, {
        title: "mizan-gpp (AEP)",
        version: "0.1.0",
        description: "Forms-as-a-service on the hono-aep suite — baas/spec/ is the contract.",
        servers: [],
      }) as Promise<Record<string, unknown>>;
      return Response.json(await documentPromise);
    },
    "/v1/*": async (request: Request) => {
      if (request.method === "OPTIONS") return preflight();
      // ONE wide event per API request (observability): trace propagated
      // from the caller's traceparent or minted; route class keeps ids out
      // (cardinality-safe); emitted as one JSON line — wrangler tail /
      // Workers Logs / any shipper ingest it. The inner handler does the
      // work; this wrapper only observes.
      const observed = new URL(request.url);
      const parts = observed.pathname.split("/");
      const routeClass = parts
        .map((part, at) =>
          at === 3 && parts[2] === "projects" ? ":project"
          : at >= 4 && /^[0-9a-f-]{20,}$/.test(part.split(":")[0] ?? "") ? (part.includes(":") ? `:id:${part.split(":")[1]}` : ":id")
          : part)
        .join("/");
      const wide = startWideEvent({
        service: "mizan-gpp",
        method: request.method,
        route: routeClass,
        traceparent: request.headers.get("traceparent"),
      });
      if (parts[2] === "projects" && parts[3]) wide.set("project", parts[3]);
      try {
        const response = await handleV1(request);
        wide.finish(response.status);
        // The id we EXPOSE via CORS must actually be SET (issue #2's
        // secondary finding): the trace id indexes the wide-event log.
        const headers = new Headers(response.headers);
        headers.set("X-Request-Id", wide.traceId);
        return new Response(response.body, { status: response.status, headers });
      } catch (problem) {
        wide.set("error", (problem as Error).message.slice(0, 200));
        wide.finish(500);
        throw problem;
      }
    },
  } as const;

  const handleV1 = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      // CMS-on-CMS nesting (baas/reseller-free white-label): a project's
      // OWN customers' projects are addressable UNDER it —
      // /v1/projects/{parent}/projects/{child}/** is the child's entire
      // surface, one namespace deeper. No flag, no stored edge, no infra:
      // the parent→child link is DERIVED from created_by (a child made by
      // {parent}'s pool carries `pool:{parent}:…`), so every project is a
      // sub-CMS for its pool's projects. Recursive by construction — the
      // rewrite re-enters this handler, so grandchildren nest further.
      const nest = url.pathname.match(/^\/v1\/projects\/([^/]+)\/projects\/([^/:]+)(\/.*|)$/);
      if (nest) {
        const [, parent, child, rest] = nest;
        const childRows = await db.select().from(projects).where(eq(projects.id, child!)).limit(1);
        const ownedByParent =
          typeof childRows[0]?.created_by === "string" && childRows[0].created_by.startsWith(`pool:${parent}:`);
        if (!ownedByParent) {
          return corsify(Response.json({ title: `projects/${child} is not a child of projects/${parent}.` }, { status: 404 }));
        }
        const inner = new URL(url);
        inner.pathname = `/v1/projects/${child}${rest ?? ""}`;
        // surface.md §1.1: append the verified parent so the innermost
        // handler can rebuild the caller-visible base.
        const forwarded = new Request(inner, request);
        forwarded.headers.set(ANCESTORS_HEADER, [...ancestorsOf(request), parent!].join(","));
        return handleV1(forwarded);
      }
      // The bare nested collection: a parent's children (derived from
      // created_by), public — the symmetry with the rewrite above and
      // what a white-label console lists.
      const childList = url.pathname.match(/^\/v1\/projects\/([^/]+)\/projects$/);
      if (childList && request.method === "GET") {
        const parent = childList[1]!;
        // created_by carries the uid tail (pool:{parent}:{uid}), so match by prefix.
        const all = await db.select().from(projects);
        const mine = all.filter((row) => typeof row.created_by === "string" && row.created_by.startsWith(`pool:${parent}:`));
        return corsify(Response.json({
          results: mine.map((row) => ({ path: `projects/${parent}/projects/${row.id}`, display_name: row.display_name, create_time: row.create_time })),
        }));
      }
      // JIT dispatch (baas/collections.md): /v1/projects/{p}/{plural}/…
      // where {plural} is not a compiled child → the project's declared
      // collections app (live the moment its document is applied).
      const segments = url.pathname.split("/"); // ["", "v1", "projects", p, seg, …]
      // Hosted JSON Schemas (sync.md §6 / seed.md §7): every config/seed
      // file's $schema points here. Static kinds are contract-derived
      // (collection-config converts the server's own zod validator);
      // per-project row schemas are generated from the live definition.
      if (segments[2] === "schemas" && segments[3]?.endsWith(".json") && !segments[4] && request.method === "GET") {
        const { staticSchema } = await import("./schemas");
        const schema = staticSchema(segments[3].slice(0, -".json".length), `${url.origin}/v1/schemas`);
        if (!schema) return corsify(Response.json({ title: "Unknown schema kind." }, { status: 404 }));
        return corsify(Response.json(schema, { headers: { "Cache-Control": "no-cache" } }));
      }
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "schemas" && segments[5] === "rows" &&
        segments[6]?.endsWith(".json") && !segments[7] && request.method === "GET"
      ) {
        const plural = segments[6].slice(0, -".json".length);
        const declared = await db.select().from(collections).where(eq(collections.project_id, segments[3]));
        const match = declared.find((row) => {
          const definition = row.definition as { plural?: string } | null;
          return definition?.plural === plural || row.id === plural;
        });
        if (!match) return corsify(Response.json({ title: `No collection with plural '${plural}'.` }, { status: 404 }));
        const { rowsSchema } = await import("./schemas");
        return corsify(Response.json(
          rowsSchema(match.definition as Record<string, unknown>, `${url.origin}${url.pathname}`),
          { headers: { "Cache-Control": "no-cache" } },
        ));
      }
      // Per-project secrets (spec/secrets.md): write-only values, owner-
      // gated; the self-serve keystone — auth pools + the payment gateway
      // resolve EnvRefs against these before the worker env.
      if (segments[2] === "projects" && segments[3] && segments[4] === "secrets" && !segments[6]) {
        const pid = segments[3];
        const principal = await principalFrom(
          { req: { raw: request, header: (n: string) => request.headers.get(n) } } as never,
        );
        const projectRows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
        if (!projectRows[0]) return corsify(Response.json({ title: "No such project." }, { status: 404 }));
        if (!principal || projectRows[0].created_by !== principal.userId) {
          return corsify(Response.json({ title: "Owner only." }, { status: principal ? 403 : 401 }));
        }
        const secrets = await import("./secrets");
        const { invalidatePool } = await import("./pools");
        if (!segments[5] && request.method === "GET") {
          return corsify(Response.json({ results: await secrets.listSecrets(pid) }));
        }
        if (segments[5] && !secrets.SECRET_NAME.test(segments[5])) {
          return corsify(Response.json({ title: "Secret names match ^[A-Z][A-Z0-9_]*$." }, { status: 400 }));
        }
        if (segments[5] && request.method === "PUT") {
          const body = (await request.json().catch(() => null)) as { value?: unknown } | null;
          if (typeof body?.value !== "string" || !body.value) {
            return corsify(Response.json({ title: "Body: {\"value\": \"…\"}." }, { status: 400 }));
          }
          const stored = await secrets.setSecret(pid, segments[5], body.value);
          invalidatePool(pid);
          return corsify(Response.json(stored));
        }
        if (segments[5] && request.method === "DELETE") {
          await secrets.deleteSecret(pid, segments[5]);
          invalidatePool(pid);
          return corsify(new Response(null, { status: 204 }));
        }
        return corsify(Response.json({ title: "GET list, PUT/DELETE {NAME}." }, { status: 405 }));
      }
      // Lexical search (AEP-136 :search): POST /v1/projects/{p}/{plural}:search
      // → ranked hits, hydrated through the JIT app so read policies +
      // owner pushdown still apply (search never leaks unauthorized rows).
      if (
        segments[2] === "projects" && segments[3] && segments[4]?.endsWith(":search") &&
        !segments[5] && request.method === "POST"
      ) {
        if (!search) return corsify(Response.json({ title: "No search configured." }, { status: 404 }));
        const jit = await jitProjectApp(segments[3]);
        if (!jit) return corsify(Response.json({ title: "No collections declared." }, { status: 404 }));
        const plural = segments[4].slice(0, -":search".length);
        const bodyJson = (await request.json().catch(() => ({}))) as { query?: string; limit?: number; mode?: "lexical" | "semantic" | "hybrid" };
        const hits = await search.search({
          scope: `projects/${segments[3]}`,
          collection: plural,
          query: String(bodyJson.query ?? ""),
          ...(bodyJson.limit ? { limit: bodyJson.limit } : {}),
          ...(bodyJson.mode ? { mode: bodyJson.mode } : {}),
        });
        // Hydrate through the JIT app (auth-forwarded) — a hit the caller
        // may not read simply drops out. Localized fields resolve per
        // ?locale exactly like plain reads (cms/localization.md §3).
        const localizedFields = jit.localizedFields.get(plural) ?? [];
        const searchLocale = url.searchParams.get("locale") ?? jit.locales?.default;
        const chain =
          localizedFields.length > 0 && jit.locales && searchLocale && searchLocale !== "all"
            ? fallbackChain(searchLocale, jit.locales)
            : null;
        const results: Json[] = [];
        for (const hit of hits) {
          const row = await jit.app.fetch(
            new Request(`${url.origin}/${plural}/${hit.id}`, { headers: request.headers }),
          );
          if (!row.ok) continue;
          const data = (await row.json()) as Record<string, unknown>;
          results.push({ ...(chain ? localizeRow(data, localizedFields, chain) : data), _score: hit.score });
        }
        return corsify(Response.json({ results }));
      }
      // Commerce (baas/commerce.md): cart + checkout + track. Cart/checkout
      // need the end-user principal (owner); track is client analytics.
      // Delivery claim (delivery.md §4): the ONLY door to delivered bytes —
      // the order's customer principal, or a signed expiring token. Streams
      // the item's file through the media surface; a canceled delivery is a
      // dead claim on both paths.
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "deliveries" &&
        segments[5]?.endsWith(":claim") && request.method === "GET"
      ) {
        const pid = segments[3];
        const deliveryId = segments[5].slice(0, -":claim".length);
        const item = Number(url.searchParams.get("item") ?? "0");
        const { projectDelivery } = await import("./delivery");
        const deliveries = projectDelivery(pid);
        const found = await deliveries.get(deliveryId);
        if (!found || found.status === "canceled" || found.status === "failed") {
          return corsify(Response.json({ title: "No claimable delivery." }, { status: 404 }));
        }
        const token = url.searchParams.get("token");
        let admitted = token ? await deliveries.verifyClaimToken(deliveryId, item, token) : false;
        if (!admitted) {
          const principal =
            (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
            (await (await import("./pools")).poolPrincipal(pid, request.headers));
          if (principal) {
            const order = await projectCommerce(pid).getOrder(found.orderId);
            admitted = order?.customer === principal.userId;
          }
        }
        if (!admitted) return corsify(Response.json({ title: "This delivery is not yours to claim." }, { status: 403 }));
        const file = found.items[item]?.file;
        if (!file) return corsify(Response.json({ title: "No file on this item." }, { status: 404 }));
        const media = (await import("./media")).projectMedia(pid);
        if (!media) return corsify(Response.json({ title: "Media is not enabled." }, { status: 503 }));
        return corsify(await media.app.fetch(new Request(`${url.origin}/media/${file}:download`)));
      }
      // Media (media.md, per-project): authenticated upload, public
      // download + metadata reads, project-owner-only mutation. Bytes ride
      // the blob seam (fs locally, R2 on Workers) under a project prefix.
      if (
        segments[2] === "projects" && segments[3] &&
        (segments[4] === "media" || segments[4] === "media:upload")
      ) {
        const pid = segments[3];
        const media = (await import("./media")).projectMedia(pid);
        if (!media) return corsify(Response.json({ title: "Media is not enabled on this runtime." }, { status: 503 }));
        const isUpload = segments[4] === "media:upload" && request.method === "POST";
        const isRead = request.method === "GET" || request.method === "HEAD";
        if (isUpload) {
          const principal =
            (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
            (await (await import("./pools")).poolPrincipal(pid, request.headers));
          if (!principal) return corsify(Response.json({ title: "Sign in to upload." }, { status: 401 }));
        } else if (!isRead) {
          const principal = await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never);
          const projectRows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
          if (!principal || projectRows[0]?.created_by !== principal.userId) {
            return corsify(Response.json({ title: "Only the project owner mutates media." }, { status: 403 }));
          }
        }
        const stripped = `/${segments.slice(4).join("/")}`;
        return corsify(await media.app.fetch(new Request(`${url.origin}${stripped}${url.search}`, request)));
      }
      // Merchant stats (observability's analytics face over commerce):
      // owner-only aggregates straight off the order snapshots — no
      // separate analytics store to drift.
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "commerce" &&
        segments[5] === "stats" && !segments[6] && request.method === "GET"
      ) {
        const pid = segments[3];
        const principal = await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never);
        const projectRows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
        if (!principal || projectRows[0]?.created_by !== principal.userId) {
          return corsify(Response.json({ title: "Only the project owner reads stats." }, { status: 403 }));
        }
        const { commerceTables } = await import("hono-aep-commerce");
        const sdb = db as unknown as { select(): { from(t: unknown): { where(w: unknown): Promise<unknown[]> } } };
        const scol = commerceTables.order as unknown as Record<"scope", never>;
        const rows = (await sdb.select().from(commerceTables.order).where(eq(scol.scope, `projects/${pid}`))) as {
          status: string; totalCents: number; items: { product_id?: string; name?: string; quantity?: number }[];
        }[];
        const PAID = new Set(["paid", "fulfilled", "shipped", "delivered"]);
        const byStatus: Record<string, number> = {};
        const byProduct = new Map<string, { name: string; units: number; revenue_cents: number }>();
        let revenue = 0;
        for (const row of rows) {
          byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
          if (!PAID.has(row.status)) continue;
          revenue += row.totalCents;
          for (const item of row.items ?? []) {
            const key = item.product_id ?? "unknown";
            const entry = byProduct.get(key) ?? { name: item.name ?? key, units: 0, revenue_cents: 0 };
            entry.units += item.quantity ?? 1;
            byProduct.set(key, entry);
          }
        }
        const top = [...byProduct.entries()]
          .map(([product, data]) => ({ product, ...data }))
          .sort((a, b) => b.units - a.units)
          .slice(0, 10);
        return corsify(Response.json({ orders: rows.length, revenue_cents: revenue, by_status: byStatus, top_products: top }));
      }
      // Fulfillment (commerce.md §3.4): POST /commerce/orders/{id}:advance
      // {to, reason} — MERCHANT-policied: the project owner's builder
      // principal only (customers never move fulfillment state).
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "commerce" &&
        segments[5] === "orders" && segments[6]?.includes(":") && request.method === "POST"
      ) {
        const pid = segments[3];
        const [orderId, verb] = segments[6].split(":") as [string, string];
        if (verb !== "advance") return corsify(Response.json({ title: "Unknown verb." }, { status: 404 }));
        const principal =
          (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
          (await (await import("./pools")).poolPrincipal(pid, request.headers));
        if (!principal) return corsify(Response.json({ title: "Sign in." }, { status: 401 }));
        const projectRows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
        if (projectRows[0]?.created_by !== principal.userId) {
          // Authenticated (builder or pool customer) but not the merchant.
          return corsify(Response.json({ title: "Only the project owner advances fulfillment." }, { status: 403 }));
        }
        const b = (await request.json().catch(() => ({}))) as { to?: string; reason?: string };
        try {
          const r = await projectCommerce(pid).advance({
            orderId, to: b.to as "fulfilled" | "shipped" | "delivered" | "cancelled",
            ...(b.reason ? { reason: b.reason } : {}),
          });
          return corsify(Response.json(r.order));
        } catch (problem) {
          return corsify(Response.json({ title: (problem as Error).message }, { status: 422 }));
        }
      }
      if (segments[2] === "projects" && segments[3] && segments[4] === "commerce" && segments[5] && !segments[6]) {
        const pid = segments[3];
        const commerce = projectCommerce(pid);
        if (segments[5] === "track" && request.method === "POST") {
          const ev = (await request.json().catch(() => ({}))) as { event?: string; properties?: Json };
          if (eventSink && ev.event) await eventSink({ type: `projects.${pid}.commerce.${ev.event}`, path: `projects/${pid}/commerce`, time: new Date().toISOString(), data: ev.properties ?? {} });
          return corsify(Response.json({ tracked: ev.event ?? null }, { status: 202 }));
        }
        // cart:add / cart:remove / cart / cart:checkout — the end user's cart.
        const principal =
          (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
          (await (await import("./pools")).poolPrincipal(pid, request.headers));
        if (!principal) return corsify(Response.json({ title: "Sign in." }, { status: 401 }));
        const customer = principal.userId;
        if (segments[5] === "cart" && request.method === "GET")
          return corsify(Response.json(await commerce.getCart({ scope: `projects/${pid}`, customer })));
        if (segments[5] === "orders" && request.method === "GET") {
          // ?all=1 → the MERCHANT's view: every order in the project
          // (owner-gated; a customer asking for all is a clean 403).
          if (url.searchParams.get("all") === "1") {
            const projectRows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
            if (projectRows[0]?.created_by !== principal.userId) {
              return corsify(Response.json({ title: "Only the project owner lists all orders." }, { status: 403 }));
            }
            const { commerceTables } = await import("hono-aep-commerce");
            const odb = db as unknown as { select(): { from(t: unknown): { where(w: unknown): Promise<unknown[]> } } };
            const ocol = commerceTables.order as unknown as Record<"scope", never>;
            const rows = (await odb.select().from(commerceTables.order).where(eq(ocol.scope, `projects/${pid}`))) as {
              id: string; customer: string; items: unknown; totalCents: number; currency: string; status: string; createTime: string;
            }[];
            const all = rows
              .sort((a, b) => (a.createTime < b.createTime ? 1 : -1))
              .map((row) => ({ id: row.id, customer: row.customer, items: row.items, total_cents: row.totalCents, currency: row.currency, status: row.status, create_time: row.createTime }));
            return corsify(Response.json({ orders: all }));
          }
          const orders = await commerce.orders({ scope: `projects/${pid}`, customer });
          // Deliveries ride along (delivery.md §3): download artifacts get a
          // fresh signed token so plain <a href> works from the storefront.
          const { projectDelivery } = await import("./delivery");
          const deliveries = projectDelivery(pid);
          const decorated = await Promise.all(orders.map(async (order) => {
            const rows = await deliveries.listByOrder({ scope: `projects/${pid}`, orderId: order.id });
            const withTokens = await Promise.all(rows.map(async (row) => ({
              ...row,
              artifacts: await Promise.all(row.artifacts.map(async (artifact, at) =>
                artifact.kind === "download"
                  ? { ...artifact, claim: `${artifact.claim}&token=${await deliveries.claimToken(row.id, at)}` }
                  : artifact,
              )),
            })));
            return { ...order, deliveries: withTokens };
          }));
          return corsify(Response.json({ orders: decorated }));
        }
        if (segments[5] === "cart:add" && request.method === "POST") {
          const b = (await request.json().catch(() => ({}))) as { variant?: string; quantity?: number };
          const r = await commerce.addItem({ scope: `projects/${pid}`, customer, variant: String(b.variant), quantity: b.quantity ?? 1 });
          return corsify(Response.json(r.cart));
        }
        if (segments[5] === "cart:remove" && request.method === "POST") {
          const b = (await request.json().catch(() => ({}))) as { variant?: string };
          const r = await commerce.removeItem({ scope: `projects/${pid}`, customer, variant: String(b.variant) });
          return corsify(Response.json(r.cart));
        }
        if (segments[5] === "discount:validate" && request.method === "POST") {
          const b = (await request.json().catch(() => ({}))) as { code?: string };
          const verdict = await commerce.validateDiscount({ scope: `projects/${pid}`, customer, code: String(b.code ?? "") });
          return corsify(Response.json(verdict, { status: verdict.ok ? 200 : 422 }));
        }
        if (segments[5] === "cart:checkout" && request.method === "POST") {
          const co = (await request.json().catch(() => ({}))) as { discount?: string; payment?: string };
          let order: Awaited<ReturnType<typeof commerce.checkout>>["order"];
          try {
            ({ order } = await commerce.checkout({
              scope: `projects/${pid}`, customer, ...(co.discount ? { discountCode: co.discount } : {}),
            }));
          } catch (problem) {
            // Empty cart / rejected coupon are client errors, not 500s.
            return corsify(Response.json({ title: (problem as Error).message }, { status: 422 }));
          }
          // EMBEDDED payment (gateway.md §3): the frontend keeps the page;
          // the gateway's element takes only the card fields. The verified
          // payment.succeeded webhook fires :pay — same money discipline.
          if (co.payment === "embedded") {
            // The project's own gateway first (spec/secrets.md §2 — the
            // owner's Stripe), the operator's global one as fallback.
            const active = (await (await import("./secrets")).projectGateway(pid)) ?? gateway;
            if (!active) return corsify(Response.json({ title: "Embedded payment is not configured." }, { status: 422 }));
            try {
              const payment = await active.createPayment({
                amountCents: order.total_cents,
                currency: order.currency,
                description: `Order ${order.id.slice(0, 8)}`,
                metadata: { order: order.id, project: pid, principal: customer },
              });
              return corsify(Response.json({
                order,
                payment: { gateway: active.name, clientToken: payment.clientToken, client: active.clientConfig() },
              }));
            } catch (problem) {
              return corsify(Response.json({ title: (problem as Error).message }, { status: 502 }));
            }
          }
          // Bridge to billing (commerce.md §3): charge the order TOTAL (an
          // ad-hoc amount — an order snapshots its own price, it is not a
          // catalog product). local self-serve settles instantly, so we fire
          // the :pay transition here; a real provider (stripe) returns a
          // hosted session and the paid webhook fires :pay (see below).
          if (billing) {
            const session = await billing
              .checkoutAmount({
                amountCents: order.total_cents,
                currency: order.currency,
                productName: `Order ${order.id.slice(0, 8)}`,
                principal: customer,
                metadata: { order: order.id, project: pid },
                successUrl: `${url.origin}/v1/projects/${pid}/commerce/order?ok=${order.id}`,
                cancelUrl: `${url.origin}/v1/projects/${pid}/commerce/order?cancel=${order.id}`,
              })
              .catch(() => null);
            if (session && "paid" in session) {
              const { order: paid } = await commerce.pay({ orderId: order.id, payment: "local" });
              return corsify(Response.json({ order: paid }));
            }
            return corsify(Response.json({ order, checkout: session }));
          }
          return corsify(Response.json({ order }));
        }
      }
      // Flags (OpenFeature): server-evaluate the whole set against the
      // resolved principal (session/key/pool) so the SPA's first paint
      // carries values — no flash. Entitlement rules compose with billing.
      if (segments[2] === "projects" && segments[3] && segments[4] === "flags" && !segments[5] && request.method === "GET") {
        if (!flags) return corsify(Response.json({}));
        const principal =
          (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
          (await (await import("./pools")).poolPrincipal(segments[3], request.headers));
        return corsify(Response.json(flags.evaluateAll(contextOf(principal))));
      }
      // Billing self-serve (local provider): an authenticated principal
      // completes checkout → the product's entitlements are granted to
      // THEM. Real providers return a hosted checkout URL instead; grants
      // then arrive via the inbound webhook. GET → the catalog.
      if (segments[2] === "projects" && segments[3] && segments[4] === "billing" && segments[5] === "checkout" && !segments[6]) {
        if (!billing) return corsify(Response.json({ title: "No billing configured." }, { status: 404 }));
        if (request.method === "GET") return corsify(Response.json(billing.catalog()));
        if (request.method !== "POST") return corsify(Response.json({ title: "Method not allowed." }, { status: 405 }));
        const principal =
          (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
          (await (await import("./pools")).poolPrincipal(segments[3], request.headers));
        if (!principal) return corsify(Response.json({ title: "Sign in to check out." }, { status: 401 }));
        const bodyJson = (await request.json().catch(() => ({}))) as { product?: string; price?: string };
        const product = String(bodyJson.product ?? "");
        const price = String(bodyJson.price ?? "monthly");
        const origin = `${url.origin}`;
        const result = await billing.checkout({
          principal: principal.userId,
          product,
          price,
          successUrl: `${origin}/v1/projects/${segments[3]}/billing/checkout?ok=1`,
          cancelUrl: `${origin}/v1/projects/${segments[3]}/billing/checkout?cancel=1`,
        });
        return corsify(Response.json(result));
      }
      // Developer keys for END-USERS (keys.md's TODO(saastarter) branch):
      // a pool customer mints an sk_ key bound to THEIR principal — the
      // key then acts exactly as their session does (orders, wishlist,
      // commerce) through keyPrincipal. The global /v1/keys:mint stays
      // builder-only (sync keys).
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "keys:mint" &&
        !segments[5] && request.method === "POST"
      ) {
        const principal =
          (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
          (await (await import("./pools")).poolPrincipal(segments[3], request.headers));
        if (!principal) return corsify(Response.json({ title: "Sign in to mint a key." }, { status: 401 }));
        const minted = await createApiKey(db, {
          class: "secret",
          name: "developer",
          userId: principal.userId,
          scopes: ["*"],
        });
        return corsify(Response.json({ plaintext: minted.plaintext, display: minted.display }));
      }
      // Billing portal (manage payment method / cancel subscription): the
      // principal's customer mapping was recorded from a verified webhook;
      // no mapping → 404 (nothing to manage yet).
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "billing" &&
        segments[5] === "portal" && !segments[6] && request.method === "POST"
      ) {
        if (!billing) return corsify(Response.json({ title: "No billing configured." }, { status: 404 }));
        const principal =
          (await principalFrom({ req: { raw: request, header: (n: string) => request.headers.get(n) } } as never)) ??
          (await (await import("./pools")).poolPrincipal(segments[3], request.headers));
        if (!principal) return corsify(Response.json({ title: "Sign in." }, { status: 401 }));
        const b = (await request.json().catch(() => ({}))) as { returnUrl?: string };
        try {
          const portal = await billing.portalUrl({
            principal: principal.userId,
            returnUrl: String(b.returnUrl ?? `${url.origin}/`),
          });
          if (!portal) return corsify(Response.json({ title: "No billing history to manage." }, { status: 404 }));
          return corsify(Response.json(portal));
        } catch (problem) {
          return corsify(Response.json({ title: (problem as Error).message }, { status: 502 }));
        }
      }
      // Stripe webhooks: Stripe's own signature (not Standard Webhooks) →
      // billing verifies + grants. Public; the signature is the auth.
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "billing" &&
        segments[5] === "stripe-webhook" && !segments[6] && request.method === "POST"
      ) {
        const projectId = segments[3]!;
        const body = await request.text();
        const signature = request.headers.get("Stripe-Signature");

        /**
         * Drive the order machine from a VERIFIED neutral event. `project`
         * is passed by the caller, never read from the payload, because the
         * payload's metadata is chosen by whoever created the payment — a
         * merchant could otherwise name someone else's project and pay
         * their orders.
         */
        const applyPayment = async (
          name: string,
          neutral: import("hono-aep-gateway").NeutralPaymentEvent | null,
          project: string,
        ): Promise<void> => {
          const order = neutral?.metadata["order"];
          if (!neutral || !order) return;
          const commerce = projectCommerce(project);
          if (neutral.type === "payment.succeeded") {
            await commerce.pay({ orderId: order, payment: `${name}:${neutral.paymentId}` }).catch(() => null);
          } else if (neutral.type === "refund.succeeded") {
            await commerce.refund({ orderId: order, reason: "gateway refund" }).catch(() => null);
          }
        };

        // VERIFY FIRST, DISPATCH SECOND. Three secrets can legitimately sign
        // events on this path — the project's own Stripe, the operator's
        // gateway, and the operator's billing — so each is tried in turn.
        // Nothing is acted on, and nothing returns 202, until some secret we
        // hold has actually verified the payload: `billing.handleWebhook`
        // returns `{ignored:true}` WITHOUT verifying when its provider is not
        // stripe, so falling through to it would 202 a forged signature.
        //
        // MERCHANT FIRST (secrets.md §2). A project that declared its own
        // STRIPE_* takes money into ITS account, so Stripe signs with ITS
        // webhook secret. Verifying those against the OPERATOR's secret is
        // precisely why `:pay` never fired and orders sat unpaid.
        const own = await (await import("./secrets")).projectGateway(projectId);
        if (own && (await own.verifyWebhook({ signature, body }))) {
          // Verified with THIS project's secret ⇒ act only on this project,
          // whatever the payload's metadata claims.
          await applyPayment(own.name, own.webhookEvent(JSON.parse(body) as Json), projectId);
          return corsify(Response.json({ ok: true, scope: "project" }, { status: 202 }));
        }

        // OPERATOR-HOSTED commerce: one gateway serving many projects, so
        // here `project` in the metadata IS the routing key — as trusted as
        // the operator signature that just verified this payload.
        if (gateway && (await gateway.verifyWebhook({ signature, body }))) {
          const neutral = gateway.webhookEvent(JSON.parse(body) as Json);
          await applyPayment(gateway.name, neutral, neutral?.metadata["project"] ?? projectId);
          return corsify(Response.json({ ok: true, scope: "platform" }, { status: 202 }));
        }

        // PLATFORM BILLING: the operator's subscription events → entitlement
        // grants. Only a stripe-configured billing instance can verify; a
        // `local` one must never be treated as an authority.
        if (billing?.provider === "stripe") {
          try {
            const result = await billing.handleWebhook({ signature, body });
            const parsedEvent = JSON.parse(body) as Json;
            const { stripeEventToOrder } = await import("hono-aep-billing");
            const orderRef = stripeEventToOrder(parsedEvent);
            if (orderRef) {
              const commerce = projectCommerce(orderRef.projectId ?? projectId);
              await commerce.pay({ orderId: orderRef.orderId, payment: `stripe:${orderRef.eventId}` }).catch(() => null);
            }
            return corsify(Response.json(result, { status: 202 }));
          } catch (problem) {
            return corsify(Response.json({ title: (problem as Error).message }, { status: 401 }));
          }
        }

        // No secret we hold verified this payload.
        return corsify(Response.json(
          { title: "No configured webhook secret verified this signature." },
          { status: 401 },
        ));
      }
      // Inbound webhooks (connections consumer): signed third-party
      // events (Stripe, …) verified then handed to jobs — NEVER inline.
      // Public by design; the SIGNATURE is the authentication.
      if (
        segments[2] === "projects" &&
        segments[3] &&
        segments[4] === "webhooks" &&
        segments[5] &&
        !segments[6] &&
        request.method === "POST"
      ) {
        if (!connectionsConsumer) return corsify(Response.json({ title: "No jobs engine." }, { status: 503 }));
        // The connection instance is named by the URL segment (app-level
        // instances today; per-project inbound registration is the next
        // step, mirroring collections/themes).
        return corsify(await connectionsConsumer.receive(segments[5], request));
      }
      // Per-project OpenAPI (site.md §5 / baas/collections.md §5): the
      // JIT app's contract — the white-label admin reads THIS. Public so
      // the static SPA can build its admin model.
      if (segments[2] === "projects" && segments[3] && segments[4] === "openapi.json" && !segments[5]) {
        // surface.md §2: the document enumerates BOTH planes, so it is
        // generated from the SURFACE (definitions + data), not the JIT app
        // alone — the same model the MCP projection describes.
        const { projectSurfaceApp } = await import("./surface");
        const surface = await projectSurfaceApp(segments[3], aep);
        if (!surface) return corsify(Response.json({ title: "No collections declared." }, { status: 404 }));
        const doc = await openApiDocument(surface.contract, {
          title: `${segments[3]} (mizan-gpp)`,
          version: "1.0.0",
          description: "Per-project AEP contract — the definition and data planes of one surface.",
          // surface.md §1: the BASE the CALLER used, not the rewritten flat
          // path — a nested document must address the nested surface.
          servers: [{ url: `${url.origin}${surfaceBase(request, segments[3])}` }],
        });
        return corsify(Response.json(doc));
      }
      // Per-project MCP (surface.md §3): the agent projection of this
      // surface — both planes, seven generic verbs, stateless. Nested
      // children arrive here already unwrapped, so a parent drives its
      // child's agent surface at the same path one level deeper.
      if (segments[2] === "projects" && segments[3] && segments[4] === "mcp" && !segments[5]) {
        const { projectSurfaceApp } = await import("./surface");
        const surface = await projectSurfaceApp(segments[3], aep);
        if (!surface) return corsify(Response.json({ title: "No collections declared." }, { status: 404 }));
        return corsify(await surface.mcp.app.fetch(new Request(`${url.origin}/mcp${url.search}`, request)));
      }
      // END-USER auth pools (auth-pools.md): better-auth mounted per
      // project, bearer-first; basePath matches, so no path rewriting.
      if (segments[2] === "projects" && segments[3] && segments[4] === "auth") {
        const pool = await projectPool(segments[3]);
        if (!pool) return corsify(Response.json({ title: "No auth pool declared." }, { status: 404 }));
        return corsify(await pool.handler(request));
      }
      // Hosted theme serving (baas/site.md §1): one <link> tag restyles the
      // consumer's whole SPA — doubled selectors beat its bundled defaults.
      // Unified interface (spec/interface.md): the ONE engine at
      // /v1/projects/{p}/(studio|admin) — same built bundle, the app reads
      // {project, mode} from the path. Nested children arrive here already
      // unwrapped by the CMS-on-CMS rewrite at the top of handleV1, so the
      // parent-nested routes serve the child's interface for free. The
      // shell's <script>/chunk refs are absolute (Workers Static Assets).
      if (segments[2] === "projects" && segments[3] && (segments[4] === "studio" || segments[4] === "admin") && !segments[5] && request.method === "GET") {
        const { studioShellHtml } = await import("./generated/studio-shell");
        return corsify(new Response(studioShellHtml, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" } }));
      }
      if (segments[2] === "projects" && segments[3] && segments[4] === "theme.css" && !segments[5]) {
        const rows = await db.select().from(themes).where(eq(themes.project_id, segments[3])).limit(1);
        if (!rows[0]) return corsify(Response.json({ title: "No theme declared." }, { status: 404 }));
        const parsed = parseThemeCss(String(rows[0].id), rows[0].css);
        return corsify(
          new Response(renderThemeCss(parsed), {
            headers: { "Content-Type": "text/css;charset=utf-8", "Cache-Control": "no-cache" },
          }),
        );
      }
      // Hosted site assets (baas/site.md §2): admin.html + bootstrap-ui.js
      // + manifest/robots/sitemap/llms/sw, generated from the project doc
      // (site.*) and PUBLIC collection reads (an anonymous internal fetch,
      // so list policies gate exactly what a crawler could see anyway).
      // Frontends may self-host instead; origin-bound assets (robots, sw)
      // are copied at publish time.
      if (segments[2] === "projects" && segments[3] && segments[4] === "site" && segments[5] && !segments[6] && request.method === "GET") {
        const pid = segments[3];
        const asset = segments[5];
        const { adminHtml, bootstrapUiJs, llmsTxt, manifestJson, robotsTxt, sitemapXml, swJs } = await import("./site-assets");
        const text = (body: string, type: string) =>
          corsify(new Response(body, { headers: { "Content-Type": type, "Cache-Control": "no-cache" } }));
        if (asset === "admin.html") return text(adminHtml(), "text/html;charset=utf-8");
        if (asset === "bootstrap-ui.js") return text(bootstrapUiJs(), "text/javascript;charset=utf-8");
        const projectRows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
        if (!projectRows[0]) return corsify(Response.json({ title: "No such project." }, { status: 404 }));
        const site = (projectRows[0].site ?? {}) as import("./site-assets").SiteDoc;
        const displayName = projectRows[0].display_name ?? pid;
        if (asset === "manifest.webmanifest")
          return text(JSON.stringify(manifestJson(displayName, site), null, 2), "application/manifest+json");
        if (asset === "favicon.svg") {
          const { faviconSvg } = await import("./site-og");
          return text(faviconSvg(displayName, site), "image/svg+xml;charset=utf-8");
        }
        if (asset === "og.png") {
          const { ogCardSvg, renderPng } = await import("./site-og");
          const kicker = site.url ? new URL(site.url).host : displayName;
          const png = await renderPng(ogCardSvg(
            { kicker, title: site.app?.name ?? displayName, subtitle: site.description }, site));
          return corsify(new Response(png, {
            headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } }));
        }
        if (asset === "robots.txt") return text(robotsTxt(site, `${url.origin}/v1/projects/${pid}/site`), "text/plain;charset=utf-8");
        if (asset === "sw.js") return text(swJs(site), "text/javascript;charset=utf-8");
        if (asset === "llms.txt" || asset === "sitemap.xml") {
          const defaultLocale = site.locales?.default ?? "en";
          const fetchPublic = async (plural: string): Promise<Record<string, unknown>[]> => {
            const synth = new URL(`${url.origin}/v1/projects/${pid}/${plural}?locale=${defaultLocale}&max_page_size=200`);
            let response: Response;
            if (plural === "pages") {
              response = await aep.app.fetch(new Request(`${url.origin}/projects/${pid}/pages`));
            } else {
              const jit = await jitProjectApp(pid);
              if (!jit) return [];
              const { localizedJitFetch } = await import("./localize");
              response = await localizedJitFetch(jit, new Request(synth), synth, `/${plural}`);
            }
            if (!response.ok) return [];
            return ((await response.json()) as { results?: Record<string, unknown>[] }).results ?? [];
          };
          if (asset === "llms.txt") return text(await llmsTxt(displayName, site, fetchPublic), "text/plain;charset=utf-8");
          const sitemap = await sitemapXml(site, fetchPublic);
          if (!sitemap) return corsify(Response.json({ title: "Set site.url to generate a sitemap." }, { status: 422 }));
          return text(sitemap, "application/xml;charset=utf-8");
        }
        return corsify(Response.json({ title: "Unknown site asset." }, { status: 404 }));
      }
      // Per-entity OG cards: /site/og/{plural}/{id}.png — field mapping
      // from site.assets.og[plural], row via an anonymous public read.
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "site" && segments[5] === "og" &&
        segments[6] && segments[7]?.endsWith(".png") && !segments[8] && request.method === "GET"
      ) {
        const pid = segments[3];
        const plural = segments[6];
        const id = decodeURIComponent(segments[7].slice(0, -".png".length));
        const projectRows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
        const site = (projectRows[0]?.site ?? {}) as import("./site-assets").SiteDoc;
        const mapping = site.assets?.og?.[plural];
        if (!mapping) return corsify(Response.json({ title: `No og mapping for ${plural} (site.assets.og).` }, { status: 404 }));
        const jit = await jitProjectApp(pid);
        if (!jit) return corsify(Response.json({ title: "No collections declared." }, { status: 404 }));
        const defaultLocale = site.locales?.default ?? "en";
        const synth = new URL(`${url.origin}/v1/projects/${pid}/${plural}/${id}?locale=${defaultLocale}`);
        const { localizedJitFetch } = await import("./localize");
        const rowResponse = await localizedJitFetch(jit, new Request(synth), synth, `/${plural}/${id}`);
        if (!rowResponse.ok) return corsify(rowResponse);
        const row = (await rowResponse.json()) as Record<string, unknown>;
        const flat = (value: unknown) =>
          typeof value === "object" && value !== null ? String(Object.values(value as object)[0] ?? "") : String(value ?? "");
        const { ogCardSvg, renderPng } = await import("./site-og");
        const png = await renderPng(ogCardSvg({
          kicker: mapping.kicker ?? (site.url ? new URL(site.url).host : plural),
          title: flat(row[mapping.title ?? "name"] ?? row.title) || id,
          subtitle: mapping.subtitle ? flat(row[mapping.subtitle]) : undefined,
          badge: mapping.money && row[mapping.money] != null ? `$${(Number(row[mapping.money]) / 100).toFixed(2)}` : undefined,
        }, site));
        return corsify(new Response(png, {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } }));
      }
      if (
        segments[2] === "projects" &&
        segments[3] &&
        !segments[3].includes(":") &&
        segments[4] &&
        !COMPILED_CHILD_PLURALS.has(segments[4].split(":")[0]!)
      ) {
        const jit = await jitProjectApp(segments[3]);
        if (jit) {
          const stripped = `/${segments.slice(4).join("/")}`;
          // The locale layer (cms/localization.md §3) wraps every JIT
          // request — no-op for collections without localized fields.
          const { localizedJitFetch } = await import("./localize");
          return corsify(await localizedJitFetch(jit, request, url, stripped));
        }
      }
      // Localized page variants (cms/localization.md §2): GET pages/{slug}
      // ?locale=X resolves the sibling `slug@locale` through the fallback
      // chain, landing on the base document as the terminal fallback.
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "pages" &&
        segments[5] && !segments[5].includes("@") && !segments[5].includes(":") &&
        !segments[6] && request.method === "GET" && url.searchParams.get("locale")
      ) {
        const locale = url.searchParams.get("locale")!;
        const projectRows = await db.select().from(projects).where(eq(projects.id, segments[3])).limit(1);
        const site = projectRows[0]?.site as { locales?: unknown } | null;
        const parsed = localizationConfigSchema.safeParse(site?.locales);
        if (parsed.success && locale !== parsed.data.default) {
          for (const tag of fallbackChain(locale, parsed.data)) {
            if (tag === parsed.data.default) break; // base document = terminal fallback
            const variant = await aep.app.fetch(
              new Request(`${url.origin}/projects/${segments[3]}/pages/${segments[5]}@${tag}`, { headers: request.headers }),
            );
            if (variant.ok) return corsify(variant);
          }
        }
        // fall through to the base document (locale stripped is unnecessary —
        // the AEP GET ignores unknown query params)
      }
      return corsify(
        await aep.app.fetch(
          new Request(`${url.origin}${url.pathname.replace(/^\/v1/, "") || "/"}${url.search}`, request),
        ),
      );
  };
  return async (incoming: Request): Promise<Response> => {
    // TRUE INGRESS — the one place internal routing state is scrubbed
    // (surface.md §1.1, domains.md §7.4). Ancestry and the domain marker
    // are appended only by ownership-verified rewrites below; a caller that
    // could declare either would mint documents advertising, or route
    // itself into, a surface it does not own.
    const request = stripInternal(incoming);
    const url = new URL(request.url);
    // Custom origins (domains.md §3): resolve Host → surface BEFORE
    // routing, then continue on the platform path. The domain marker rides
    // along so generators re-emit the origin the caller used instead of the
    // platform path this rewrite produced.
    const host = request.headers.get("host") ?? url.host;
    if (!url.pathname.startsWith("/v1/projects/")) {
      const resolved = await domainSurface(host);
      if (resolved === "unverified") {
        return corsify(Response.json(
          { title: "This domain is not verified.", detail: `${host} is claimed but not ACTIVE; publish its challenge TXT and call :verify.` },
          { status: 404 },
        ));
      }
      if (resolved) {
        const inner = new URL(url);
        const suffix = url.pathname === "/" ? "" : url.pathname;
        inner.pathname = `/v1/projects/${resolved.project}${suffix}`;
        const forwarded = new Request(inner, stripInternal(request));
        forwarded.headers.set(DOMAIN_HEADER, host);
        return corsify(await routes["/v1/*"](forwarded));
      }
    }
    const path = url.pathname;
    // /submit/:key
    const submitMatch = /^\/submit\/([^/]+)$/.exec(path);
    if (submitMatch) {
      if (request.method === "OPTIONS") return preflight();
      if (request.method === "POST") return corsify(await submit(request, decodeURIComponent(submitMatch[1]!)));
    }
    if (path === "/") return routes["/"]();
    // The hosted DEVELOPER studio (product §1b's "website" writer) —
    // same-origin, so builder cookies just work. /studio is the dogfooded
    // React console (dist/studio-assets, served by Workers Static Assets
    // in prod and by index.ts locally — this branch only fires when the
    // bundle is absent); /studio-lite is the zero-build vanilla fallback.
    if (path === "/studio") {
      return new Response(null, { status: 302, headers: { Location: "/studio-lite" } });
    }
    if (path === "/studio-lite") {
      return new Response(studioHtml, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }
    // The studio package's FontPicker catalog (the one /developer-api
    // surface it self-fetches). Static list — no fs at the edge.
    if (path === "/developer-api/font-catalog") {
      return Response.json({
        fonts: [
          "IBM Plex Sans", "IBM Plex Mono", "Fraunces", "Inter", "Geist", "Space Grotesk",
          "Source Serif 4", "JetBrains Mono", "Lora", "Manrope", "Work Sans", "DM Sans",
          "Libre Franklin", "Crimson Pro", "Fira Code", "Newsreader", "Outfit", "Sora",
          "Spectral", "Zilla Slab",
        ],
      });
    }
    if (path === "/api/auth/*".replace("*", "") || path.startsWith("/api/auth/")) {
      // Cross-origin platform auth (self-clonability): any static origin
      // may host a console — preflight + CORS, bearer-first via
      // set-auth-token (already in Expose-Headers).
      if (request.method === "OPTIONS") return preflight();
      return corsify(await routes["/api/auth/*"](request));
    }
    if (path === "/v1/keys:mint") {
      if (request.method === "OPTIONS") return preflight();
      return corsify(await routes["/v1/keys:mint"].POST(request));
    }
    if (path === "/v1/openapi.json") return routes["/v1/openapi.json"]();
    if (path === "/livez" || path === "/readyz" || path === "/healthz") return probes.fetch(request);
    if (path.startsWith("/v1/")) return routes["/v1/*"](request);
    return Response.json({ title: "Not found." }, { status: 404 });
  };
}
