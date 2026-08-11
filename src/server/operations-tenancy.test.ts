import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * `/v1/operations` is registered `policy: "authenticated"` — which asks only
 * "are you signed in?", never "is this yours?". Job rows carry `error` and
 * `response` on the wire, so if the list is not tenant-scoped, one signup
 * reads every project's failures.
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
      email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "supersecret1",
      name: tag,
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
};

describe("operations tenancy", () => {
  it("does not show one account another account's operations", async () => {
    // Alice does something that enqueues work. An empty-database assertion
    // would pass vacuously, so the leak has to be given something to leak.
    const alice = await signUp("alice-ops");
    const project = (await (
      await fetch(url("/v1/projects"), {
        method: "POST",
        headers: { ...json, Cookie: alice },
        body: JSON.stringify({ display_name: "Alice ops" }),
      })
    ).json()) as { path: string };
    const form = (await (
      await fetch(url(`/v1/${project.path}/forms`), {
        method: "POST",
        headers: { ...json, Cookie: alice },
        body: JSON.stringify({ display_name: "Alice form", notify_email: "alice@example.com" }),
      })
    ).json()) as { submit_key: string };

    const submitted = await fetch(url(`/submit/${form.submit_key}`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "buyer@example.com", message: "alice-secret-payload" }),
    });
    expect([200, 303]).toContain(submitted.status);

    const mine = (await (
      await fetch(url("/v1/operations?max_page_size=50"), { headers: { Cookie: alice } })
    ).json()) as { results: unknown[] };
    expect(mine.results.length).toBeGreaterThan(0); // the leak has something to find

    // Bob owns nothing here. Whatever Alice just enqueued must be invisible.
    const bob = await signUp("bob-ops");
    const listed = await fetch(url("/v1/operations?max_page_size=50"), {
      headers: { Cookie: bob },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(0);
  });
});
