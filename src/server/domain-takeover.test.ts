import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * domains.md §7 says a host never routes without proof of control, and §7.6
 * says the platform's own zone is never handed to a tenant. These are the
 * tests that hold those two claims to account.
 *
 * Both were written after an audit asserted the claims were unenforced. They
 * are deliberately written as ATTACKS: each one performs the exact call an
 * attacker would make and asserts it is refused.
 */

let server: TestServer;
const PLATFORM_ZONE = "saastemly.com";
const url = (path: string) => `${server.origin}${path}`;
const json = { "Content-Type": "application/json" };

beforeAll(async () => {
  // The suffix MUST come from here, not from the caller's shell: these tests
  // assert that the platform zone is unclaimable, and with no suffix
  // configured that guard is a no-op — so an externally-set variable would
  // make them pass for a reason unrelated to the code under test.
  server = await startTestServer({ PLATFORM_HOST_SUFFIX: PLATFORM_ZONE });
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

const newProject = async (cookie: string, name: string): Promise<string> => {
  const response = await fetch(url("/v1/projects"), {
    method: "POST",
    headers: { ...json, Cookie: cookie },
    body: JSON.stringify({ display_name: name }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { path: string }).path;
};

const claimDomain = async (cookie: string, project: string, host: string, kind = "api") =>
  await fetch(url(`/v1/${project}/domains?id=${encodeURIComponent(host)}`), {
    method: "POST",
    headers: { ...json, Cookie: cookie },
    body: JSON.stringify({ kind }),
  });

describe("domain takeover surface", () => {
  it("refuses to activate a host whose challenge was never published", async () => {
    // The whole point of the challenge (domains.md §7.1): declaring is not
    // owning. If :activate moves PENDING → ACTIVE with no proof, the
    // challenge is decoration and any host can be claimed by anyone.
    const cookie = await signUp("owner");
    const project = await newProject(cookie, "Owner project");
    const claimed = await claimDomain(cookie, project, "never-proven.example.com");
    expect(claimed.status).toBe(201);

    const activated = await fetch(
      url(`/v1/${project}/domains/never-proven.example.com:activate`),
      { method: "POST", headers: { ...json, Cookie: cookie }, body: "{}" },
    );
    expect(activated.status).not.toBe(200);
  });

  it("refuses :activate from a caller who does not own the project", async () => {
    // Custom methods and transitions must inherit the resource's policies.
    // If they do not, every :verb is an unauthenticated write.
    const alice = await signUp("alice");
    const project = await newProject(alice, "Alice's");
    expect((await claimDomain(alice, project, "alice-host.example.com")).status).toBe(201);

    const anonymous = await fetch(
      url(`/v1/${project}/domains/alice-host.example.com:activate`),
      { method: "POST", headers: json, body: "{}" },
    );
    expect([401, 403, 404]).toContain(anonymous.status);

    const bob = await signUp("bob");
    const asBob = await fetch(
      url(`/v1/${project}/domains/alice-host.example.com:activate`),
      { method: "POST", headers: { ...json, Cookie: bob }, body: "{}" },
    );
    expect([401, 403, 404]).toContain(asBob.status);
  });

  it("refuses to claim a host on the platform's own zone", async () => {
    // domains.md §7.6 / §1a.3. The fallback host {project}-api.{zone} is
    // derived, so a domains row for one is a claim on someone else's
    // surface — and the apex is the platform's own.
    const cookie = await signUp("squatter");
    const project = await newProject(cookie, "Squatter");

    for (const host of [
      "saastemly.com",
      "api.saastemly.com",
      "victim-api.saastemly.com",
      "anything.saastemly.com",
    ]) {
      const claimed = await claimDomain(cookie, project, host);
      expect(
        [400, 403, 409],
        `${host} should be refused, got ${claimed.status}`,
      ).toContain(claimed.status);
    }
  });
});
