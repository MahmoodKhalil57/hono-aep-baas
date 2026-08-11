import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * `:provision` spends a customer's Cloudflare credential. Everything about
 * who may invoke it, and what happens when no credential is connected, is
 * tested over real HTTP — the unit tests cover the record logic, these cover
 * the door.
 */

let server: TestServer;
let cloudflare: { stop: () => void; created: Record<string, unknown>[] };
const url = (path: string) => `${server.origin}${path}`;
const json = { "Content-Type": "application/json" };

/**
 * A stand-in Cloudflare. The real one is not a dependency any test may have,
 * and pointing at it would mean holding a live account credential to run the
 * suite.
 */
const startCloudflareStub = async () => {
  const created: Record<string, unknown>[] = [];
  const zone = { id: "zone-1", name: "example.com" };
  const server = createServer((request, response) => {
    const { pathname, searchParams } = new URL(request.url ?? "/", "http://stub");
    const send = (result: unknown, status = 200): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: status === 200, result, errors: [] }));
    };
    if (pathname.endsWith("/zones")) return send([zone]);
    if (pathname.endsWith("/dns_records") && request.method === "GET") {
      // `taken.example.com` already belongs to the customer.
      return send(
        searchParams.get("name") === "taken.example.com"
          ? [{ id: "x", type: "A", name: "taken.example.com", content: "203.0.113.1" }]
          : [],
      );
    }
    if (pathname.endsWith("/dns_records") && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        created.push(JSON.parse(raw || "{}") as Record<string, unknown>);
        send({ id: `rec-${created.length}` });
      });
      return;
    }
    return send(null, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => server.close(),
    created,
  };
};

beforeAll(async () => {
  const stub = await startCloudflareStub();
  cloudflare = stub;
  server = await startTestServer({ CLOUDFLARE_API_BASE: stub.origin });
});
afterAll(async () => {
  await server.stop();
  cloudflare.stop();
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

const setup = async (tag: string, host: string) => {
  const cookie = await signUp(tag);
  const project = ((await (
    await fetch(url("/v1/projects"), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ display_name: `${tag} project` }),
    })
  ).json()) as { path: string }).path;
  const created = await fetch(url(`/v1/${project}/domains?id=${encodeURIComponent(host)}`), {
    method: "POST",
    headers: { ...json, Cookie: cookie },
    body: JSON.stringify({ kind: "site", target: "someone.github.io" }),
  });
  expect(created.status).toBe(201);
  return { cookie, project };
};

const provision = (project: string, host: string, cookie?: string, body: unknown = {}) =>
  fetch(url(`/v1/${project}/domains/${host}:provision`), {
    method: "POST",
    headers: { ...json, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

describe(":provision authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    const host = "anon.example.com";
    const { project } = await setup("prov-anon", host);
    const response = await provision(project, host);
    expect(response.status).toBe(401);
  });

  it("refuses a signed-in caller who does not own the project", async () => {
    // The interesting case: spending SOMEONE ELSE's Cloudflare credential.
    const host = "cross.example.com";
    const { project } = await setup("prov-owner", host);
    const intruder = await signUp("prov-intruder");
    const response = await provision(project, host, intruder);
    expect([403, 404]).toContain(response.status);
  });

  it("tells the owner what to do when no credential is connected", async () => {
    const host = "nocred.example.com";
    const { cookie, project } = await setup("prov-nocred", host);
    const response = await provision(project, host, cookie);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { title: string; detail: string };
    expect(body.detail).toContain("CLOUDFLARE_API_TOKEN");
    // An actionable instruction, not a stack trace: this is the first thing
    // every new user will hit.
    expect(body.detail).toMatch(/Zone/);
  });
});

const connect = (project: string, cookie: string) =>
  fetch(url(`/v1/${project}/secrets/CLOUDFLARE_API_TOKEN`), {
    method: "PUT",
    headers: { ...json, Cookie: cookie },
    body: JSON.stringify({ value: "cf-test-token" }),
  });

describe(":provision end to end", () => {
  it("plans, applies, and is a no-op on re-run", async () => {
    const host = "shop.example.com";
    const { cookie, project } = await setup("prov-e2e", host);
    expect((await connect(project, cookie)).status).toBeLessThan(300);

    // dry_run first: a plan must be inspectable without side effects.
    const planned = (await (await provision(project, host, cookie, { dry_run: true })).json()) as {
      applied: boolean; zone: string; created: number;
      plan: { action: string; type: string; name: string; proxied: boolean }[];
    };
    expect(planned.applied).toBe(false);
    expect(planned.created).toBe(0);
    expect(planned.zone).toBe("example.com");
    expect(planned.plan.map((entry) => entry.action)).toEqual(["create", "create"]);

    const before = cloudflare.created.length;
    expect(before).toBe(0); // dry_run really wrote nothing

    const applied = (await (await provision(project, host, cookie)).json()) as {
      applied: boolean; created: number;
    };
    expect(applied.applied).toBe(true);
    expect(applied.created).toBe(2);

    const written = cloudflare.created;
    expect(written).toHaveLength(2);
    const cname = written.find((record) => record["type"] === "CNAME")!;
    // The measured rule: a Pages CNAME must not be proxied.
    expect(cname["proxied"]).toBe(false);
    expect(cname["content"]).toBe("someone.github.io");
    expect(String(cname["comment"])).toContain("hono-aep:");
    const txt = written.find((record) => record["type"] === "TXT")!;
    expect(String(txt["name"])).toBe(`_hono-aep-challenge.${host}`);
  });

  it("refuses a site domain with no target instead of half-provisioning it", async () => {
    // Writing only the challenge would leave the domain verifiable but
    // pointing nowhere, and report success for it.
    const host = "notarget.example.com";
    const cookie = await signUp("prov-notarget");
    const project = ((await (
      await fetch(url("/v1/projects"), {
        method: "POST", headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ display_name: "No target" }),
      })
    ).json()) as { path: string }).path;
    expect((await fetch(url(`/v1/${project}/domains?id=${encodeURIComponent(host)}`), {
      method: "POST", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ kind: "site" }), // no target
    })).status).toBe(201);
    expect((await connect(project, cookie)).status).toBeLessThan(300);

    const before = cloudflare.created.length;
    const response = await provision(project, host, cookie);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { detail: string }).detail).toContain("target");
    expect(cloudflare.created.length).toBe(before); // nothing written
  });

  it("reports a conflict and writes nothing when the name is taken", async () => {
    const host = "taken.example.com";
    const { cookie, project } = await setup("prov-conflict", host);
    expect((await connect(project, cookie)).status).toBeLessThan(300);

    const before = cloudflare.created.length;
    const result = (await (await provision(project, host, cookie)).json()) as {
      plan: { action: string; type: string; detail?: string }[];
    };
    const cname = result.plan.find((entry) => entry.type === "CNAME")!;
    expect(cname.action).toBe("conflict");
    // The customer's own A record survives untouched — only the TXT, whose
    // name is free, gets written.
    expect(cloudflare.created.length).toBe(before + 1);
  });
});
