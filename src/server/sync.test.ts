import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diff, fmt, pull, push } from "../../bin/sync";
import { startTestServer, type TestServer } from "./test-server";

/**
 * The sync client against the real server (sync.md §7 conformance):
 * push is Apply-driven and idempotent; pull reifies output-only fields
 * (the submit key!); prune needs its explicit flag; drift surfaces as a
 * hard error pointing at pull; pull-then-push is a no-op.
 */

let server: TestServer;
let dir: string;
let key: string;

const canonical = (body: unknown): string => `${JSON.stringify(body, null, 2)}\n`;

beforeAll(async () => {
  server = await startTestServer();
  dir = mkdtempSync(join(tmpdir(), "baas-sync-"));

  // Bootstrap: sign up, then mint the sync key over HTTP (/v1/keys:mint —
  // the minimal slice of keys.md's management story; sync.md §5 requires
  // an sk_ key, never a session).
  const signUp = await fetch(`${server.origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `sync-${Date.now()}@example.com`,
      password: "supersecret1",
      name: "Sync",
    }),
  });
  const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
  const minted = await fetch(`${server.origin}/v1/keys:mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  expect(minted.status).toBe(200);
  key = ((await minted.json()) as { plaintext: string }).plaintext;
  expect(key).toMatch(/^sk_live_/);

  writeFileSync(
    join(dir, "baas.json"),
    canonical({ endpoint: server.origin, project: "richpetshop2", resources: ["forms/*.cms.json"] }),
  );
  writeFileSync(join(dir, "project.cms.json"), canonical({ display_name: "richPetShop 2" }));
  mkdirSync(join(dir, "forms"), { recursive: true });
  writeFileSync(
    join(dir, "forms", "contact.cms.json"),
    canonical({ display_name: "Contact", notify_email: "owner@rps2.example" }),
  );
});
afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("sync (baas/sync.md)", () => {
  it("push creates from files, twice is a no-op, and pull reifies the submit key", async () => {
    const context = { dir, key };
    const first = await push(context);
    expect(first.applied).toBe(2); // project + contact form
    expect(first.pruned).toBe(0);

    const second = await push(context);
    expect(second.applied).toBe(0);
    expect(second.noops).toBe(2); // §7: push twice ≡ no-op

    const pulled = await pull(context);
    expect(pulled.written).toContain("forms/contact.cms.json");
    const reified = JSON.parse(readFileSync(join(dir, "forms", "contact.cms.json"), "utf8")) as {
      submit_key: string;
      created_by: string;
    };
    expect(reified.submit_key).toMatch(/^pk_live_/); // §2.3 — the embed value
    expect(reified.created_by).toBeTruthy();

    // Pull-then-push is a no-op (§7: round-trip across the wire).
    const third = await push(context);
    expect(third.applied).toBe(0);

    // The minted key SURVIVES a config change (re-apply preserves it).
    writeFileSync(
      join(dir, "forms", "contact.cms.json"),
      canonical({ display_name: "Contact us", notify_email: "owner@rps2.example" }),
    );
    await push(context);
    await pull(context);
    const after = JSON.parse(readFileSync(join(dir, "forms", "contact.cms.json"), "utf8")) as {
      submit_key: string;
      display_name: string;
    };
    expect(after.display_name).toBe("Contact us");
    expect(after.submit_key).toBe(reified.submit_key);
  }, 30_000);

  it("prune requires its explicit flag; diff plans it first", async () => {
    const context = { dir, key };
    writeFileSync(
      join(dir, "forms", "newsletter.cms.json"),
      canonical({ display_name: "Newsletter", notify_email: "owner@rps2.example" }),
    );
    await push(context);
    rmSync(join(dir, "forms", "newsletter.cms.json"));

    const plan = await diff(context);
    expect(plan.some((entry) => entry.action === "prune" && entry.path.endsWith("/newsletter"))).toBe(true);

    const withoutFlag = await push(context);
    expect(withoutFlag.pruned).toBe(0); // skip without --prune
    const withFlag = await push(context, { prune: true });
    expect(withFlag.pruned).toBe(1);
  }, 30_000);

  it("fmt reprints to canonical form", () => {
    writeFileSync(join(dir, "forms", "contact.cms.json"), '{"notify_email":"owner@rps2.example","display_name":"Contact us"}');
    const result = fmt({ dir, key: "" });
    expect(result.formatted).toContain("forms/contact.cms.json");
    const text = readFileSync(join(dir, "forms", "contact.cms.json"), "utf8");
    expect(text.startsWith('{\n  "display_name"')).toBe(true); // sorted keys
  });
});

describe("sync: .cms.css documents (themes)", () => {
  it("pushes raw css, server canonicalizes, pull reifies the canonical form", async () => {
    const context = { dir, key };
    // Manifest gains the themes glob.
    const manifest = JSON.parse(readFileSync(join(dir, "baas.json"), "utf8")) as {
      resources: string[];
    };
    manifest.resources.push("themes/*.cms.css");
    writeFileSync(join(dir, "baas.json"), canonical(manifest));
    mkdirSync(join(dir, "themes"), { recursive: true });
    writeFileSync(
      join(dir, "themes", "default.cms.css"),
      ":root{--primary:oklch(0.6 0.1 200)}\n.dark{--primary:oklch(0.8 0.1 200)}",
    );

    const pushed = await push(context);
    expect(pushed.applied).toBeGreaterThanOrEqual(1);

    await pull(context);
    const reified = readFileSync(join(dir, "themes", "default.cms.css"), "utf8");
    expect(reified).toContain("/* cms-theme: default"); // canonical came back
    expect(reified.startsWith("{")).toBe(false); // raw css, not a JSON envelope

    // Canonical local file ⇒ push is a no-op (round-trip across the wire).
    const again = await push(context);
    expect(again.applied).toBe(0);
  }, 30_000);
});
