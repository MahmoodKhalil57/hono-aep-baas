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
