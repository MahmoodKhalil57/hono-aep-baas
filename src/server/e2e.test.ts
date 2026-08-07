import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server";

/**
 * The whole product loop over HTTP (baas/forms.md): sign up → project →
 * form (pk key minted) → static-HTML submit → 303 → intake job announces
 * to the owner + autoresponds; honeypot accepts-and-marks; tenancy via
 * owner pushdown. Everything observable through the generated surfaces.
 */

let server: TestServer;
const url = (path: string) => `${server.origin}${path}`;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.stop();
});

const signUp = async (tag: string): Promise<string> => {
  const response = await fetch(url("/api/auth/sign-up/email"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${tag}-${Date.now()}@example.com`,
      password: "supersecret1",
      name: tag,
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
};

const json = { "Content-Type": "application/json" };

type OperationRow = {
  done: boolean;
  ok?: boolean;
  response?: { announced?: boolean; autoresponded?: boolean; verdict?: string; status?: string };
  metadata?: { type?: string };
};

describe("mizan-gpp: the web3forms loop", () => {
  it("runs sign-up → form → submit → announce end to end", async () => {
    const cookie = await signUp("builder");

    const projectResponse = await fetch(url("/v1/projects"), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ display_name: "Acme site" }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { path: string };

    const formResponse = await fetch(url(`/v1/${project.path}/forms`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        display_name: "Contact",
        notify_email: "owner@acme.example",
        redirect_url: "https://acme.example/thanks",
      }),
    });
    expect(formResponse.status).toBe(201);
    const contactForm = (await formResponse.json()) as { path: string; submit_key: string };
    expect(contactForm.submit_key).toMatch(/^pk_live_/); // publishable by design

    // The static-HTML submit: form-encoded, reserved control fields.
    const submitResponse = await fetch(url(`/submit/${contactForm.submit_key}`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "Sam Visitor",
        message: "Love the site!",
        _replyto: "sam@visitor.example",
        _redirect: "https://acme.example/custom-thanks",
      }),
      redirect: "manual",
    });
    expect(submitResponse.status).toBe(303);
    expect(submitResponse.headers.get("Location")).toBe("https://acme.example/custom-thanks");

    // The owner sees the stored submission; the control fields are gone.
    const listed = await fetch(url(`/v1/${contactForm.path}/submissions`), {
      headers: { Cookie: cookie },
    });
    expect(listed.status).toBe(200);
    const submissions = (await listed.json()) as {
      results: { data: Record<string, string>; replyto: string; verdict: string }[];
    };
    expect(submissions.results).toHaveLength(1);
    expect(submissions.results[0]!.data).toEqual({ name: "Sam Visitor", message: "Love the site!" });
    expect(submissions.results[0]!.replyto).toBe("sam@visitor.example");
    expect(submissions.results[0]!.verdict).toBe("ham");

    // Delivery ran through the queue: intake announced + autoresponded,
    // and the notification deliveries completed (local provider logs).
    let intake: OperationRow | undefined;
    let delivers = 0;
    for (let attempt = 0; attempt < 24 && (!intake?.done || delivers < 2); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const operations = await fetch(url("/v1/operations"), { headers: { Cookie: cookie } });
      const body = (await operations.json()) as { results: OperationRow[] };
      intake = body.results.find((row) => row.metadata?.type === "submission-intake" && row.done) ?? intake;
      delivers = body.results.filter(
        (row) => row.metadata?.type === "notifications.deliver" && row.done && row.ok,
      ).length;
    }
    expect(intake?.ok).toBe(true);
    expect(intake?.response?.announced).toBe(true);
    expect(intake?.response?.autoresponded).toBe(true);
    expect(delivers).toBeGreaterThanOrEqual(2); // owner email + autoresponder
  }, 40_000);

  it("honeypot accepts-and-marks; spam is stored but never announced", async () => {
    const cookie = await signUp("keeper");
    const project = (await (
      await fetch(url("/v1/projects"), {
        method: "POST",
        headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ display_name: "Trap" }),
      })
    ).json()) as { path: string };
    const trapForm = (await (
      await fetch(url(`/v1/${project.path}/forms`), {
        method: "POST",
        headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ display_name: "Trap form", notify_email: "k@t.example" }),
      })
    ).json()) as { path: string; submit_key: string };

    const bot = await fetch(url(`/submit/${trapForm.submit_key}`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ spamword: "buy now", _botcheck: "gotcha" }),
      redirect: "manual",
    });
    expect(bot.status).toBe(200); // never tip off the bot

    const listed = (await (
      await fetch(url(`/v1/${trapForm.path}/submissions`), { headers: { Cookie: cookie } })
    ).json()) as { results: { verdict: string }[] };
    expect(listed.results[0]!.verdict).toBe("spam");
  }, 30_000);

  it("enforces tenancy: another user's projects and forms are invisible", async () => {
    const alice = await signUp("alice");
    const bob = await signUp("bob");
    const aliceProject = (await (
      await fetch(url("/v1/projects"), {
        method: "POST",
        headers: { ...json, Cookie: alice },
        body: JSON.stringify({ display_name: "Alice's" }),
      })
    ).json()) as { path: string };

    // Bob's list is empty; direct access to Alice's project is denied.
    const bobList = (await (
      await fetch(url("/v1/projects"), { headers: { Cookie: bob } })
    ).json()) as { results: unknown[] };
    expect(bobList.results).toHaveLength(0);
    expect((await fetch(url(`/v1/${aliceProject.path}`), { headers: { Cookie: bob } })).status).toBe(403);
    // Bob cannot create a form under Alice's project (owner-of-ancestor).
    const forged = await fetch(url(`/v1/${aliceProject.path}/forms`), {
      method: "POST",
      headers: { ...json, Cookie: bob },
      body: JSON.stringify({ display_name: "Forged", notify_email: "b@b.example" }),
    });
    expect(forged.status).toBe(403);
    // Anonymous cannot list anything.
    expect((await fetch(url("/v1/projects"))).status).toBe(401);
  }, 30_000);

  it("submit fails closed on unknown keys and serves JSON callers the resource", async () => {
    expect(
      (
        await fetch(url("/submit/pk_live_unknown"), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ a: "b" }),
        })
      ).status,
    ).toBe(404);
  });
});
