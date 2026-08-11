import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * Click-to-connect (spec/connect.md), tested as attacks.
 *
 * The one that matters is the reverse-CSRF: Mallory starts a flow on HER
 * project and lures Alice through consent, trying to spend Alice's provider
 * account on Mallory's project. Committing at the callback loses to it; so
 * does binding to a cookie alone, or to the starting principal alone. The
 * test below runs it.
 */

let server: TestServer;
let provider: { origin: string; stop: () => void; issued: number };
const url = (path: string) => `${server.origin}${path}`;
const json = { "Content-Type": "application/json" };

/** A stand-in Cloudflare OAuth token endpoint. */
const startProviderStub = async () => {
  let issued = 0;
  const http = createServer((request, response) => {
    if (request.url?.startsWith("/token")) {
      let raw = "";
      request.on("data", (c) => (raw += c));
      request.on("end", () => {
        issued += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          access_token: `granted-token-${issued}`,
          refresh_token: "r",
          expires_in: 14400,
        }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => http.close(),
    get issued() { return issued; },
  };
};

beforeAll(async () => {
  provider = await startProviderStub();
  // The callback is refused anywhere but the registered redirect URI's HOST —
  // ports are not part of that boundary, which is what makes this workable
  // against a server on an arbitrary test port. The check still runs for
  // real; `refuses the callback on any other host` below proves it bites.
  server = await startTestServer({
    CF_OAUTH_CLIENT_ID: "test-client",
    CF_OAUTH_CLIENT_SECRET: "test-secret",
    CF_OAUTH_BASE: provider.origin,
    CONNECT_REDIRECT_URI: "http://localhost/connect/callback",
  });
});
afterAll(async () => {
  await server.stop();
  provider.stop();
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

const newProject = async (cookie: string, name: string): Promise<string> =>
  ((await (
    await fetch(url("/v1/projects"), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ display_name: name }),
    })
  ).json()) as { path: string }).path;

const connect = async (project: string, cookie: string) => {
  const response = await fetch(url(`/v1/${project}:connect`), {
    method: "POST",
    headers: { ...json, Cookie: cookie },
    body: JSON.stringify({ provider: "cloudflare" }),
  });
  const flowCookie = (response.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*__Host-)/)
    .map((c) => c.trim())
    .find((c) => c.startsWith("__Host-aep_connect="))
    ?.split(";")[0];
  return { response, body: (await response.json()) as Record<string, string>, flowCookie };
};

const claim = (project: string, cookie: string, state: string, flowCookie?: string) =>
  fetch(url(`/v1/${project}:claim-connection`), {
    method: "POST",
    headers: { ...json, Cookie: [cookie, flowCookie].filter(Boolean).join("; ") },
    body: JSON.stringify({ state }),
  });

const consent = (state: string) =>
  fetch(url(`/connect/callback?code=abc123&state=${encodeURIComponent(state)}`), { redirect: "manual" });

const secrets = async (project: string, cookie: string) =>
  ((await (await fetch(url(`/v1/${project}/secrets`), { headers: { Cookie: cookie } })).json()) as {
    results: { name: string }[];
  }).results.map((row) => row.name);

describe("click-to-connect", () => {
  it("refuses :connect from a non-owner and from anonymous", async () => {
    const alice = await signUp("c-alice");
    const project = await newProject(alice, "Alice");
    const anon = await fetch(url(`/v1/${project}:connect`), {
      method: "POST", headers: json, body: JSON.stringify({ provider: "cloudflare" }),
    });
    expect(anon.status).toBe(401);
    const bob = await signUp("c-bob");
    const asBob = await fetch(url(`/v1/${project}:connect`), {
      method: "POST", headers: { ...json, Cookie: bob }, body: JSON.stringify({ provider: "cloudflare" }),
    });
    expect([403, 404]).toContain(asBob.status);
  });

  it("completes for the owner, in the same browser, and stores the token", async () => {
    const alice = await signUp("c-happy");
    const project = await newProject(alice, "Happy");
    const started = await connect(project, alice);
    expect(started.response.status).toBe(200);
    expect(started.body["authorize_url"]).toContain("code_challenge_method=S256");
    expect(started.flowCookie).toBeTruthy();

    // Nothing is stored merely because consent happened.
    expect(await secrets(project, alice)).not.toContain("CLOUDFLARE_API_TOKEN");
    expect((await consent(started.body["state"]!)).status).toBe(200);
    expect(await secrets(project, alice)).not.toContain("CLOUDFLARE_API_TOKEN");

    const claimed = await claim(project, alice, started.body["state"]!, started.flowCookie);
    expect(claimed.status).toBe(200);
    expect(await secrets(project, alice)).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("REFUSES the reverse-CSRF: a lured consent cannot be spent on the luring project", async () => {
    // Mallory starts a flow on her own project — entirely legitimate so far.
    const mallory = await signUp("c-mallory");
    const malloryProject = await newProject(mallory, "Mallory");
    const started = await connect(malloryProject, mallory);
    const state = started.body["state"]!;

    // Alice is lured through consent. Her browser holds the flow cookie; the
    // grant is now parked against Mallory's project.
    expect((await consent(state)).status).toBe(200);

    // Mallory has her session but NOT the cookie (it was set in Alice's
    // browser). She cannot commit.
    const withoutCookie = await claim(malloryProject, mallory, state);
    expect(withoutCookie.status).toBe(409);

    // Alice has the cookie but is not the flow's principal — and it is not
    // her project either. She cannot commit.
    const alice = await signUp("c-victim");
    const asAlice = await claim(malloryProject, alice, state, started.flowCookie);
    expect([403, 404, 409]).toContain(asAlice.status);

    // The grant is spent by nobody.
    expect(await secrets(malloryProject, mallory)).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("refuses a claim for a different project than the flow started on", async () => {
    const carol = await signUp("c-carol");
    const first = await newProject(carol, "First");
    const second = await newProject(carol, "Second");
    const started = await connect(first, carol);
    await consent(started.body["state"]!);
    const crossed = await claim(second, carol, started.body["state"]!, started.flowCookie);
    expect(crossed.status).toBe(409);
    expect(await secrets(second, carol)).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("is single-use — a replayed claim does not re-commit", async () => {
    const dave = await signUp("c-dave");
    const project = await newProject(dave, "Dave");
    const started = await connect(project, dave);
    await consent(started.body["state"]!);
    expect((await claim(project, dave, started.body["state"]!, started.flowCookie)).status).toBe(200);
    const replay = await claim(project, dave, started.body["state"]!, started.flowCookie);
    expect(replay.status).toBe(409);
  });

  it("refuses an unknown or forged state at the callback", async () => {
    const forged = await consent("not-a-real-state");
    expect(forged.status).toBe(400);
  });

  it("refuses the callback on any host but the registered one", async () => {
    // A callback arriving on a tenant's custom domain is either a
    // misconfiguration or an attempt to intercept an authorization code, and
    // the ingress rewrite would otherwise swallow the path entirely.
    // fetch() silently drops a Host header (it is forbidden), so this has to
    // go out over a raw request or it would quietly test nothing.
    const target = new URL(server.origin);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: "/connect/callback?code=a&state=b",
          method: "GET",
          headers: { Host: "api.someone-elses-domain.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(404);
  });
});
