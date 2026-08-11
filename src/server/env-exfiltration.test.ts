import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * secrets.md §2's resolution ladder lets project config carry `{"$env": NAME}`
 * and resolves it against the project's secrets OVER the worker env. The
 * worker env is the OPERATOR's — it holds the platform's own credentials.
 *
 * `auth_pool` is owner-writable free-form config, and the EnvRef NAME inside
 * it is chosen by the tenant. So the question this test settles is: can a
 * tenant name one of the OPERATOR's secrets and get its value back out?
 */

let server: TestServer;
const url = (path: string) => `${server.origin}${path}`;
const json = { "Content-Type": "application/json" };

/** A stand-in for a platform credential that no tenant may ever read. */
const OPERATOR_SECRET = "sk_platform_do_not_leak_9f3a2b";

beforeAll(async () => {
  server = await startTestServer({ PLATFORM_ONLY_SECRET: OPERATOR_SECRET });
});
afterAll(async () => {
  await server.stop();
});

describe("worker env is not reachable through tenant config", () => {
  it("refuses to resolve an operator secret named by a tenant EnvRef", async () => {
    const signUp = await fetch(url("/api/auth/sign-up/email"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        email: `exfil-${Date.now()}@example.com`,
        password: "supersecret1",
        name: "exfil",
      }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;

    const project = ((await (
      await fetch(url("/v1/projects"), {
        method: "POST",
        headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ display_name: "Exfil" }),
      })
    ).json()) as { path: string }).path;

    // The attack: point a social-provider EnvRef at the OPERATOR's env.
    const configured = await fetch(url(`/v1/${project}`), {
      method: "PATCH",
      headers: { ...json, "Content-Type": "application/merge-patch+json", Cookie: cookie },
      body: JSON.stringify({
        auth_pool: {
          emailPassword: { enabled: true },
          social: {
            google: {
              clientId: { $env: "PLATFORM_ONLY_SECRET" },
              clientSecret: { $env: "PLATFORM_ONLY_SECRET" },
            },
          },
        },
      }),
    });
    expect(configured.status).toBe(200);

    // better-auth puts client_id in the authorize URL it redirects to, so a
    // resolved value is directly readable by whoever triggers the sign-in.
    const signIn = await fetch(url(`/v1/${project}/auth/sign-in/social`), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ provider: "google", callbackURL: "https://example.com/back" }),
      redirect: "manual",
    });

    const location = signIn.headers.get("location") ?? "";
    const body = await signIn.text().catch(() => "");
    expect(location).not.toContain(OPERATOR_SECRET);
    expect(body).not.toContain(OPERATOR_SECRET);
  });
});
