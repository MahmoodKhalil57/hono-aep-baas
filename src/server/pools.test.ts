import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * END-USER auth pools over HTTP (auth-pools.md §§1, 1a, 1b): a project
 * enables its pool, end users sign up bearer-first, their sessions drive
 * owner-scoped JIT rows, and tenancy holds — same email across pools,
 * tokens that never cross projects, owner stamping from the principal.
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

const builderSignUp = async (tag: string): Promise<string> => {
  const response = await fetch(url("/api/auth/sign-up/email"), {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email: `${tag}-${Date.now()}@example.com`, password: "supersecret1", name: tag }),
  });
  return response.headers.get("set-cookie")!.split(";")[0]!;
};

const endUserSignUp = async (project: string, email: string): Promise<string | null> => {
  const response = await fetch(url(`/v1/${project}/auth/sign-up/email`), {
    method: "POST",
    headers: { ...json, Origin: "https://someone.github.io" },
    body: JSON.stringify({ email, password: "supersecret1", name: "End User" }),
  });
  if (response.status !== 200) return null;
  return response.headers.get("set-auth-token");
};

describe("auth pools over HTTP", () => {
  it("pool off → 404; enable via project update → live; bearer sign-up works cross-origin", async () => {
    const cookie = await builderSignUp("pooler");
    const projectResponse = await fetch(url("/v1/projects"), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ display_name: "Pooled" }),
    });
    const project = ((await projectResponse.json()) as { path: string }).path;

    expect(
      (await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: "{}" }))
        .status,
    ).toBe(404); // no pool declared

    // Enable the pool — live on the next request (cache invalidation).
    expect(
      (
        await fetch(url(`/v1/${project}`), {
          method: "PATCH",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify({ auth_pool: { emailPassword: { enabled: true } } }),
        })
      ).status,
    ).toBe(200);

    const token = await endUserSignUp(project, "visitor@example.com");
    expect(token).toBeTruthy(); // set-auth-token, CORS-exposed — §1a

    // The bearer session drives an owner-scoped JIT collection: the OWNER
    // FIELD IS STAMPED from the pool principal, and pushdown isolates rows.
    await fetch(url(`/v1/${project}/collections/notes`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "note",
          plural: "notes",
          fields: [
            { name: "text", type: "string", required: true },
            { name: "created_by", type: "string" },
          ],
          owner: "created_by",
          policy_create: "authenticated",
          policy_list: { owner: { field: "created_by" } },
          policy_get: { owner: { field: "created_by" } },
        },
      }),
    });
    const created = await fetch(url(`/v1/${project}/notes`), {
      method: "POST",
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "mine" }),
    });
    expect(created.status).toBe(201);
    const wire = (await created.json()) as { created_by: string };
    expect(wire.created_by.startsWith("pool:")).toBe(true); // stamped, not client-sent

    const second = await endUserSignUp(project, "other@example.com");
    const mine = (await (
      await fetch(url(`/v1/${project}/notes`), { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { results: unknown[] };
    const theirs = (await (
      await fetch(url(`/v1/${project}/notes`), { headers: { Authorization: `Bearer ${second}` } })
    ).json()) as { results: unknown[] };
    expect(mine.results).toHaveLength(1);
    expect(theirs.results).toHaveLength(0);
    expect((await fetch(url(`/v1/${project}/notes`))).status).toBe(401); // anon
  }, 40_000);

  it("tenancy: same email in two pools; a token never crosses projects", async () => {
    const cookie = await builderSignUp("tenancy");
    const make = async (name: string): Promise<string> => {
      const response = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ display_name: name, auth_pool: {} }),
      });
      return ((await response.json()) as { path: string }).path;
    };
    const projectA = await make("A");
    const projectB = await make("B");

    const tokenA = await endUserSignUp(projectA, "same@example.com");
    const tokenB = await endUserSignUp(projectB, "same@example.com");
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy(); // §1b: composite (project, email) uniqueness

    // Declare an authenticated-create collection in B; A's token is a
    // stranger there (401 — the principal chain resolves nothing).
    await fetch(url(`/v1/${projectB}/collections/items`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "item",
          plural: "items",
          fields: [{ name: "label", type: "string", required: true }],
          policy_create: "authenticated",
        },
      }),
    });
    expect(
      (
        await fetch(url(`/v1/${projectB}/items`), {
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${tokenA}` },
          body: JSON.stringify({ label: "sneak" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url(`/v1/${projectB}/items`), {
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${tokenB}` },
          body: JSON.stringify({ label: "legit" }),
        })
      ).status,
    ).toBe(201);
  }, 40_000);
});
