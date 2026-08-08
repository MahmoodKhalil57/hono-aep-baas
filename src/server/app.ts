// mizan-gpp server body — runtime-neutral (Bun + Cloudflare Workers).
// The Bun entry (index.ts) and the Worker (worker.ts) each install their
// db + service instances, then import THIS for the fetch handler.
import { eq } from "drizzle-orm";
import { aepApp, attachMcp, openApiDocument, type Json } from "hono-aep";
import { createApiKey, keyPrincipal } from "hono-aep-auth";
import { createHealthProbes } from "hono-aep-observability";
import { parseThemeCss, renderThemeCss } from "hono-aep-cms";
import { contextOf } from "hono-aep-flags";
import { projectCommerce } from "./commerce";
import { db } from "../db/registry";
import { forms, tables, themes } from "../db/schema";
import { drizzleAepStorage } from "hono-aep-drizzle";
import { block, collection, form, page, project, submission, theme } from "./resources";
import { COMPILED_CHILD_PLURALS, jitProjectApp } from "./jit-collections";
import { projectPool } from "./pools";
import { authn, billing, connectionsConsumer, eventSink, flags, jobs, notifications, principalFrom, search } from "./services";

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
    theme,
    page,
    block,
    ...(jobs ? [jobs.resource({ policy: "authenticated" })] : []),
    ...(notifications ? [notifications.feedResource()] : []),
  ],
  storage: drizzleAepStorage({ db, tables, resources: [project, form, submission, collection, theme, page, block] }),
  serviceName: "baas.hono-aep.dev",
  basePath: "/v1",
  ...(authn ? { authorization: { principal: principalFrom } } : {}),
  ...(eventSink ? { onEvent: eventSink } : {}),
});
attachMcp(aep, { name: "mizan-gpp" });

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
  "Access-Control-Expose-Headers": "ETag, X-Request-Id, set-auth-token",
} as const;

const preflight = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, X-Request-Id",
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
      const url = new URL(request.url);
      // JIT dispatch (baas/collections.md): /v1/projects/{p}/{plural}/…
      // where {plural} is not a compiled child → the project's declared
      // collections app (live the moment its document is applied).
      const segments = url.pathname.split("/"); // ["", "v1", "projects", p, seg, …]
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
        // may not read simply drops out.
        const results: Json[] = [];
        for (const hit of hits) {
          const row = await jit.app.fetch(
            new Request(`${url.origin}/${plural}/${hit.id}`, { headers: request.headers }),
          );
          if (row.ok) results.push({ ...(await row.json()), _score: hit.score });
        }
        return corsify(Response.json({ results }));
      }
      // Commerce (baas/commerce.md): cart + checkout + track. Cart/checkout
      // need the end-user principal (owner); track is client analytics.
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
        if (segments[5] === "cart:checkout" && request.method === "POST") {
          const { order } = await commerce.checkout({ scope: `projects/${pid}`, customer });
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
      // Stripe webhooks: Stripe's own signature (not Standard Webhooks) →
      // billing verifies + grants. Public; the signature is the auth.
      if (
        segments[2] === "projects" && segments[3] && segments[4] === "billing" &&
        segments[5] === "stripe-webhook" && !segments[6] && request.method === "POST"
      ) {
        if (!billing) return corsify(Response.json({ title: "No billing." }, { status: 404 }));
        try {
          const body = await request.text();
          const result = await billing.handleWebhook({
            signature: request.headers.get("Stripe-Signature"),
            body,
          });
          // Payment → order (commerce.md §3 flow 3): a VERIFIED paid session
          // carrying order coordinates fires the order's :pay transition —
          // THAT is what emits the trustworthy order_completed + decrements
          // inventory. handleWebhook already verified the signature above.
          const { stripeEventToOrder } = await import("hono-aep-billing");
          const orderRef = stripeEventToOrder(JSON.parse(body) as Json);
          if (orderRef) {
            const commerce = projectCommerce(orderRef.projectId ?? segments[3]!);
            await commerce.pay({ orderId: orderRef.orderId, payment: `stripe:${orderRef.eventId}` }).catch(() => null);
          }
          return corsify(Response.json(result, { status: 202 }));
        } catch (problem) {
          return corsify(Response.json({ title: (problem as Error).message }, { status: 401 }));
        }
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
        const jit = await jitProjectApp(segments[3]);
        if (!jit) return corsify(Response.json({ title: "No collections declared." }, { status: 404 }));
        const doc = await openApiDocument(jit, {
          title: `${segments[3]} (mizan-gpp)`,
          version: "1.0.0",
          description: "Per-project AEP contract — hosted collections.",
          servers: [{ url: `${url.origin}/v1/projects/${segments[3]}` }],
        });
        return corsify(Response.json(doc));
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
          return corsify(
            await jit.app.fetch(new Request(`${url.origin}${stripped}${url.search}`, request)),
          );
        }
      }
      return corsify(
        await aep.app.fetch(
          new Request(`${url.origin}${url.pathname.replace(/^\/v1/, "") || "/"}${url.search}`, request),
        ),
      );
    },
    "/livez": (request: Request) => probes.fetch(request),
    "/readyz": (request: Request) => probes.fetch(request),
    "/healthz": (request: Request) => probes.fetch(request),
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    // /submit/:key
    const submitMatch = /^\/submit\/([^/]+)$/.exec(path);
    if (submitMatch) {
      if (request.method === "OPTIONS") return preflight();
      if (request.method === "POST") return corsify(await submit(request, decodeURIComponent(submitMatch[1]!)));
    }
    if (path === "/") return routes["/"]();
    if (path === "/api/auth/*".replace("*", "") || path.startsWith("/api/auth/")) return routes["/api/auth/*"](request);
    if (path === "/v1/keys:mint") return routes["/v1/keys:mint"].POST(request);
    if (path === "/v1/openapi.json") return routes["/v1/openapi.json"]();
    if (path === "/livez") return routes["/livez"](request);
    if (path === "/readyz") return routes["/readyz"](request);
    if (path === "/healthz") return routes["/healthz"](request);
    if (path.startsWith("/v1/")) return routes["/v1/*"](request);
    return Response.json({ title: "Not found." }, { status: 404 });
  };
}
