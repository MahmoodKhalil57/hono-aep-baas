import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * Hosted collections end-to-end (baas/collections.md, cms/execution-
 * modes.md): a builder APPLIES a collection document and its resource is
 * live immediately — rows, policies, transitions, filters — over one
 * json_rows table; definitions re-apply live (no restart); tenants are
 * isolated; reserved plurals are refused.
 */

let server: TestServer;
const url = (path: string) => `${server.origin}${path}`;
const json = { "Content-Type": "application/json" };

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.stop();
});

const signUp = async (tag: string): Promise<string> => {
  const response = await fetch(url("/api/auth/sign-up/email"), {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      email: `${tag}-${Date.now()}@example.com`,
      password: "supersecret1",
      name: tag,
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
};

const makeProject = async (cookie: string, name: string): Promise<string> => {
  const response = await fetch(url("/v1/projects"), {
    method: "POST",
    headers: { ...json, Cookie: cookie },
    body: JSON.stringify({ display_name: name }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { path: string }).path;
};

const BLOG_DEFINITION = {
  singular: "post",
  plural: "posts",
  fields: [
    { name: "title", type: "string", required: true, min_length: 1 },
    { name: "body", type: "string", required: true },
    { name: "category", type: "string", enum_values: ["news", "guide"] },
  ],
  states: ["DRAFT", "PUBLISHED"],
  initial_state: "DRAFT",
  transitions: [{ verb: "publish", from: ["DRAFT"], to: "PUBLISHED" }],
  policy_create: "authenticated",
  policy_update: "authenticated",
  policy_delete: "authenticated",
  // list/get stay public — a blog IS public content.
};

describe("hosted collections (JIT)", () => {
  it("apply a definition → the resource is live: CRUD, policy, transition, filter", async () => {
    const cookie = await signUp("author");
    const project = await makeProject(cookie, "Blog site");

    const applied = await fetch(url(`/v1/${project}/collections/blog`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: BLOG_DEFINITION }),
    });
    expect(applied.status).toBe(201);

    // Live immediately — no restart, no migration.
    expect((await fetch(url(`/v1/${project}/posts`))).status).toBe(200);
    // The declared policy holds: anonymous create is refused…
    expect(
      (
        await fetch(url(`/v1/${project}/posts`), {
          method: "POST",
          headers: json,
          body: JSON.stringify({ title: "Nope", body: "x" }),
        })
      ).status,
    ).toBe(401);
    // …and the declared schema validates.
    expect(
      (
        await fetch(url(`/v1/${project}/posts?id=hello`), {
          method: "POST",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify({ title: "Hi", body: "b", category: "mystery" }),
        })
      ).status,
    ).toBe(400);

    const created = await fetch(url(`/v1/${project}/posts?id=hello`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ title: "Hello world", body: "First!", category: "news" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { state: string }).state).toBe("DRAFT");

    const published = await fetch(url(`/v1/${project}/posts/hello:publish`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: "{}",
    });
    expect(published.status).toBe(200);

    const filtered = (await (
      await fetch(url(`/v1/${project}/posts?filter=${encodeURIComponent("category == 'news'")}`))
    ).json()) as { results: { path: string; state: string }[] };
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]!.state).toBe("PUBLISHED");
  }, 30_000);

  it("re-applying a definition takes effect live (cache invalidation)", async () => {
    const cookie = await signUp("editor");
    const project = await makeProject(cookie, "Evolving");
    await fetch(url(`/v1/${project}/collections/notes`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "note",
          plural: "notes",
          fields: [{ name: "text", type: "string", required: true }],
          policy_create: "authenticated",
        },
      }),
    });
    // `rating` is not declared yet → stripped (unknown keys drop).
    const before = await fetch(url(`/v1/${project}/notes`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ text: "a", rating: 5 }),
    });
    expect(before.status).toBe(201);
    expect(((await before.json()) as { rating?: number }).rating).toBeUndefined();
    // Evolve the definition — new field accepted immediately.
    await fetch(url(`/v1/${project}/collections/notes`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "note",
          plural: "notes",
          fields: [
            { name: "text", type: "string", required: true },
            { name: "rating", type: "number", integer: true },
          ],
          policy_create: "authenticated",
        },
      }),
    });
    const after = await fetch(url(`/v1/${project}/notes`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ text: "a", rating: 5 }),
    });
    expect(after.status).toBe(201);
    expect(((await after.json()) as { rating?: number }).rating).toBe(5); // live now
  }, 30_000);

  it("isolates tenants: same plural, two projects, zero leakage", async () => {
    const alice = await signUp("alice2");
    const bob = await signUp("bob2");
    const aliceProject = await makeProject(alice, "A");
    const bobProject = await makeProject(bob, "B");
    const definition = {
      singular: "item",
      plural: "items",
      fields: [{ name: "label", type: "string", required: true }],
      policy_create: "authenticated",
    };
    for (const [cookie, project] of [
      [alice, aliceProject],
      [bob, bobProject],
    ] as const) {
      await fetch(url(`/v1/${project}/collections/items`), {
        method: "PUT",
        headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ definition }),
      });
    }
    await fetch(url(`/v1/${aliceProject}/items`), {
      method: "POST",
      headers: { ...json, Cookie: alice },
      body: JSON.stringify({ label: "Alice's" }),
    });
    const bobList = (await (await fetch(url(`/v1/${bobProject}/items`))).json()) as {
      results: unknown[];
    };
    expect(bobList.results).toHaveLength(0);
    // Bob cannot declare collections under Alice's project.
    expect(
      (
        await fetch(url(`/v1/${aliceProject}/collections/sneak`), {
          method: "PUT",
          headers: { ...json, Cookie: bob },
          body: JSON.stringify({ definition }),
        })
      ).status,
    ).toBe(403);
  }, 30_000);

  it("refuses reserved plurals and broken definitions with clear problems", async () => {
    const cookie = await signUp("careful");
    const project = await makeProject(cookie, "Guarded");
    const reserved = await fetch(url(`/v1/${project}/collections/bad`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: { singular: "form", plural: "forms", fields: [{ name: "x", type: "string" }] },
      }),
    });
    expect(reserved.status).toBe(400);
    const brokenPolicy = await fetch(url(`/v1/${project}/collections/bad`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "thing",
          plural: "things",
          fields: [{ name: "x", type: "string" }],
          policy_update: { owner: { field: "missing_field" } },
          owner: "missing_field",
        },
      }),
    });
    expect(brokenPolicy.status).toBe(400);
  }, 30_000);
});

describe("the static-origin contract (site.md §2a)", () => {
  it("serves wildcard CORS without credentials on /v1 and /submit", async () => {
    const pre = await fetch(url("/v1/projects"), {
      method: "OPTIONS",
      headers: { Origin: "https://someone.github.io", "Access-Control-Request-Method": "GET" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("If-Match");
    expect(pre.headers.get("Access-Control-Allow-Credentials")).toBeNull(); // cookies stay same-origin

    const read = await fetch(url("/v1/projects"), {
      headers: { Origin: "https://someone.github.io" },
    });
    expect(read.headers.get("Access-Control-Allow-Origin")).toBe("*"); // even on the 401
    expect(read.headers.get("Access-Control-Expose-Headers")).toContain("ETag");

    const submitPre = await fetch(url("/submit/pk_live_whatever"), {
      method: "OPTIONS",
      headers: { Origin: "https://someone.github.io", "Access-Control-Request-Method": "POST" },
    });
    expect(submitPre.status).toBe(204);
    expect(submitPre.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("P1 field branches in hosted mode", () => {
  it("unique fields answer 409 through the JIT path", async () => {
    const cookie = await signUp("uniq");
    const project = await makeProject(cookie, "Unique");
    await fetch(url(`/v1/${project}/collections/pages`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "entry",
          plural: "entries",
          fields: [
            { name: "slug", type: "string", required: true, unique: true },
            { name: "title", type: "string", required: true },
            { name: "related", type: "string", cardinality: "many", reference_collection: "entries" },
          ],
          policy_create: "authenticated",
        },
      }),
    });
    const first = await fetch(url(`/v1/${project}/entries`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ slug: "home", title: "Home", related: [] }),
    });
    expect(first.status).toBe(201);
    const dup = await fetch(url(`/v1/${project}/entries`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ slug: "home", title: "Again" }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { type: string }).type).toBe("ALREADY_EXISTS");
    // hasMany reference validates the path shape.
    const badRef = await fetch(url(`/v1/${project}/entries`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ slug: "other", title: "O", related: ["not-a-path"] }),
    });
    expect(badRef.status).toBe(400);
  }, 30_000);
});

describe("hosted themes (site.md §1)", () => {
  it("canonicalizes on write and serves doubled-selector css with CORS", async () => {
    const cookie = await signUp("themer");
    const project = await makeProject(cookie, "Themed");
    const projectId = project.split("/")[1]!;

    // Non-canonical input (odd spacing) — the round-trip law formats it.
    const applied = await fetch(url(`/v1/${project}/themes/default`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        css: ":root{--primary:oklch(0.55 0.15 45);--radius:0.5rem}\n.dark{--primary:oklch(0.7 0.15 45)}",
      }),
    });
    expect(applied.status).toBe(201);
    const stored = (await (
      await fetch(url(`/v1/${project}/themes/default`), { headers: { Cookie: cookie } })
    ).json()) as { css: string };
    expect(stored.css).toContain("/* cms-theme: default");
    expect(stored.css).toContain("  --primary: oklch(0.55 0.15 45);");

    const served = await fetch(url(`/v1/projects/${projectId}/theme.css`), {
      headers: { Origin: "https://someone.github.io" },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toContain("text/css");
    expect(served.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const css = await served.text();
    expect(css).toContain(":root:root"); // doubled — beats the SPA's bundled defaults
    expect(css).toContain(":root:root.dark");
    expect(css).toContain("--primary: oklch(0.55 0.15 45);");

    // Garbage is refused with a clear problem.
    const garbage = await fetch(url(`/v1/${project}/themes/broken`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ css: "body { color: red }" }),
    });
    expect(garbage.status).toBe(400);
  }, 30_000);
});

describe("hosted pages + blocks (site.md §1)", () => {
  it("owner declares; the world reads; Puck shape is guarded", async () => {
    const cookie = await signUp("publisher");
    const project = await makeProject(cookie, "Site");

    const pageDoc = {
      title: "About us",
      data: {
        root: { props: {} },
        content: [
          { type: "Hero", props: { id: "h1", title: "Hello", subtitle: "From a hosted page" } },
        ],
      },
    };
    expect(
      (
        await fetch(url(`/v1/${project}/pages/about`), {
          method: "PUT",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify(pageDoc),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await fetch(url(`/v1/${project}/blocks/announcement`), {
          method: "PUT",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify({ title: "Banner", data: { content: [{ type: "Markdown", props: { id: "m1", body: "**Sale!**" } }] } }),
        })
      ).status,
    ).toBe(201);

    // Public reads, no auth — the static SPA's surface (CORS asserted elsewhere).
    const read = await fetch(url(`/v1/${project}/pages/about`));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { title: string }).title).toBe("About us");
    expect((await fetch(url(`/v1/${project}/blocks/announcement`))).status).toBe(200);
    expect((await fetch(url(`/v1/${project}/pages`))).status).toBe(200);

    // Writes stay the owner's.
    expect(
      (
        await fetch(url(`/v1/${project}/pages/about`), {
          method: "PATCH",
          headers: json,
          body: JSON.stringify({ title: "Hijacked" }),
        })
      ).status,
    ).toBe(401);

    // Non-Puck data is refused.
    expect(
      (
        await fetch(url(`/v1/${project}/pages/broken`), {
          method: "PUT",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify({ title: "X", data: { nope: true } }),
        })
      ).status,
    ).toBe(400);
  }, 30_000);
});

describe("per-project OpenAPI (white-label admin source)", () => {
  it("serves the JIT app's contract with the declared collection's paths", async () => {
    const cookie = await signUp("apiuser");
    const project = await makeProject(cookie, "Contracted");
    await fetch(url(`/v1/${project}/collections/blog`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "post",
          plural: "posts",
          fields: [{ name: "title", type: "string", required: true }],
        },
      }),
    });
    const projectId = project.split("/")[1]!;
    const doc = await fetch(url(`/v1/projects/${projectId}/openapi.json`), {
      headers: { Origin: "https://someone.github.io" },
    });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await doc.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(body.paths)).toContain("/posts");
  }, 30_000);
});

describe("inbound webhooks route (connections consumer)", () => {
  it("routes POST /v1/projects/{p}/webhooks/{name} to the consumer", async () => {
    const cookie = await signUp("hookuser");
    const project = await makeProject(cookie, "Hooked");
    const projectId = project.split("/")[1]!;
    // The sample stripe connection ships DISABLED → the consumer reports
    // no such inbound connection (404 problem), proving the route reaches
    // it rather than falling through to the JIT/page 404 shell.
    const response = await fetch(url(`/v1/projects/${projectId}/webhooks/stripe`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hooks.stripe.com" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(((await response.json()) as { title: string }).title).toContain("inbound connection");
  }, 30_000);
});

describe("lexical search over collections (search kind, AEP-136)", () => {
  it("indexes on write, ranks :search by coverage, hydrates through read policy", async () => {
    const cookie = await signUp("searcher");
    const project = await makeProject(cookie, "Searchable");
    await fetch(url(`/v1/${project}/collections/blog`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "post",
          plural: "posts",
          fields: [{ name: "title", type: "string", required: true }, { name: "body", type: "string" }],
          policy_create: "authenticated",
        },
      }),
    });
    const post = (id: string, title: string, body: string) =>
      fetch(url(`/v1/${project}/posts?id=${id}`), {
        method: "POST",
        headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ title, body }),
      });
    await post("a", "Machine learning basics", "An intro to ML models");
    await post("b", "Deep learning networks", "Neural nets and learning");
    await post("c", "Sourdough bread", "Baking at home");

    const results = (await (
      await fetch(url(`/v1/${project}/posts:search`), {
        method: "POST",
        headers: json,
        body: JSON.stringify({ query: "machine learning" }),
      })
    ).json()) as { results: { path: string; _score: number }[] };
    // 'a' has both terms → first; 'b' has "learning" → second; 'c' absent.
    expect(results.results.map((r) => r.path.split("/").pop())).toEqual(["a", "b"]);
    expect(results.results[0]!._score).toBeGreaterThan(results.results[1]!._score);

    // Delete drops it from the index.
    await fetch(url(`/v1/${project}/posts/a`), { method: "DELETE", headers: { Cookie: cookie } });
    const after = (await (
      await fetch(url(`/v1/${project}/posts:search`), {
        method: "POST",
        headers: json,
        body: JSON.stringify({ query: "machine learning" }),
      })
    ).json()) as { results: { path: string }[] };
    expect(after.results.map((r) => r.path.split("/").pop())).toEqual(["b"]);
  }, 30_000);
});

describe("definition gate = the full serving pipeline (AEP-122 poison guard)", () => {
  it("rejects a snake_case singular at apply time; a poisoned row cannot break siblings", async () => {
    const cookie = await signUp("gatekeeper");
    const project = await makeProject(cookie, "Gate");
    // Apply-time rejection: defineResource's kebab-case invariant fires at PUT.
    const bad = await fetch(url(`/v1/${project}/collections/wishlist`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "wishlist_item", plural: "wishlist", fields: [{ name: "product", type: "string", required: true }] } }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { detail: string }).detail).toContain("kebab-case");
    // Kebab-case version applies, and siblings keep working.
    const good = await fetch(url(`/v1/${project}/collections/wishlist`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "wishlist-item", plural: "wishlist", fields: [{ name: "product", type: "string", required: true }, { name: "created_by", type: "string" }], policy_create: "authenticated", policy_list: { owner: { field: "created_by" } }, policy_get: { owner: { field: "created_by" } }, policy_update: { owner: { field: "created_by" } }, policy_delete: { owner: { field: "created_by" } }, owner: "created_by" } }),
    });
    expect(good.status).toBe(201);
    const list = await fetch(url(`/v1/${project}/wishlist`), { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
  }, 30_000);
});

describe("localized fields (cms/localization.md §3)", () => {
  it("flat writes merge per locale; reads resolve via the fallback chain; locale=all returns maps", async () => {
    const cookie = await signUp("localizer");
    const project = await makeProject(cookie, "Localized");
    const pid = project.split("/")[1]!;
    // site.locales on the project (§1) + a collection with a localized field.
    await fetch(url(`/v1/${project}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ site: { locales: { default: "en", supported: ["en", "ar"], fallback: {} } } }),
    });
    await fetch(url(`/v1/${project}/collections/items`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: {
        singular: "item", plural: "items",
        fields: [
          { name: "title", type: "string", required: true, localized: true },
          { name: "price", type: "number", integer: true },
        ],
        policy_create: "authenticated", policy_update: "authenticated", policy_list: "public", policy_get: "public",
      } }),
    });
    // Create with a flat title (no locale param → default locale en).
    const created = await fetch(url(`/v1/projects/${pid}/items?id=tee`), {
      method: "POST", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ title: "Classic Tee", price: 1500 }),
    });
    expect(created.status).toBe(201);
    // Add the Arabic translation via a flat PATCH under ?locale=ar.
    const patched = await fetch(url(`/v1/projects/${pid}/items/tee?locale=ar`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ title: "تي شيرت كلاسيكي" }),
    });
    expect(patched.status).toBe(200);
    // Reads resolve flat per locale; ar falls back to en for missing tags.
    const en = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=en`))).json()) as { title: string };
    const ar = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=ar`))).json()) as { title: string };
    const def = (await (await fetch(url(`/v1/projects/${pid}/items/tee`))).json()) as { title: string };
    expect(en.title).toBe("Classic Tee");
    expect(ar.title).toBe("تي شيرت كلاسيكي");
    expect(def.title).toBe("Classic Tee"); // default locale
    // locale=all returns the raw map (the authoring/export shape).
    const all = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=all`))).json()) as { title: Record<string, string> };
    expect(all.title).toEqual({ en: "Classic Tee", ar: "تي شيرت كلاسيكي" });
    // Apply (PUT) one locale flat must NOT erase the other translation.
    const put = await fetch(url(`/v1/projects/${pid}/items/tee?locale=en`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ title: "Classic Tee v2", price: 1600 }),
    });
    expect(put.status).toBe(200);
    const after = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=all`))).json()) as { title: Record<string, string> };
    expect(after.title).toEqual({ en: "Classic Tee v2", ar: "تي شيرت كلاسيكي" });
    // LIST resolves per row.
    const listed = (await (await fetch(url(`/v1/projects/${pid}/items?locale=ar`))).json()) as { results: { title: string }[] };
    expect(listed.results[0]!.title).toBe("تي شيرت كلاسيكي");
  }, 30_000);
});

describe("commerce cart→checkout (baas/commerce.md)", () => {
  it("a pool user adds a product to cart and checks out to a pending order", async () => {
    const cookie = await signUp("merchant");
    const project = await makeProject(cookie, "Shop");
    const pid = project.split("/")[1]!;
    // a products collection + one product
    await fetch(url(`/v1/${project}/collections/catalog`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "product", plural: "products", fields: [{ name: "name", type: "string", required: true }, { name: "price_cents", type: "number", integer: true }], policy_create: "authenticated", policy_get: "public", policy_list: "public" } }),
    });
    await fetch(url(`/v1/${project}/products?id=tee`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: "Tee", price_cents: 1500 }) });
    // pool user
    const tok = await (async () => {
      const r = await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `buyer-${Date.now()}@x.com`, password: "supersecret1", name: "B" }) });
      return r.headers.get("set-auth-token")!;
    })();
    // enable the pool first (project needs auth_pool)
    await fetch(url(`/v1/${project}`), { method: "PATCH", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ auth_pool: {} }) });
    const tok2 = (await (await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `buyer2-${Date.now()}@x.com`, password: "supersecret1", name: "B2" }) })).headers.get("set-auth-token"))!;
    void tok;
    const add = await fetch(url(`/v1/projects/${pid}/commerce/cart:add`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok2}` }, body: JSON.stringify({ variant: "tee", quantity: 2 }) });
    expect(add.status).toBe(200);
    const cart = (await add.json()) as { items: unknown[]; total_cents: number };
    expect(cart.items).toHaveLength(1);
    expect(cart.total_cents).toBe(3000);
    const co = await fetch(url(`/v1/projects/${pid}/commerce/cart:checkout`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok2}` }, body: "{}" });
    expect(co.status).toBe(200);
    const body = (await co.json()) as { order: { status: string; total_cents: number } };
    // local billing settles instantly → the order fires :pay in the same
    // request (commerce.md §3); a stripe provider would leave it pending
    // until the paid webhook. Either way the snapshot total is authoritative.
    expect(body.order.status).toBe("paid");
    expect(body.order.total_cents).toBe(3000);
    // The paid order shows up in the buyer's order history (commerce/orders).
    const hist = await fetch(url(`/v1/projects/${pid}/commerce/orders`), { headers: { Authorization: `Bearer ${tok2}` } });
    const { orders } = (await hist.json()) as { orders: { status: string; items: unknown[] }[] };
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("paid");
  }, 30_000);
});
