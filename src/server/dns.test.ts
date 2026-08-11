import { describe, expect, it } from "vitest";
import {
  applyPlan,
  cloudflareDns,
  cnameCollisions,
  markerFor,
  planRecords,
  zoneForHost,
  type DesiredRecord,
  type DnsProvider,
} from "./dns";

/**
 * The safety properties of BYOK DNS, tested as behaviour rather than trusted
 * as intent — this is the code that holds a customer's account credential.
 */

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });

type Call = { url: string; init?: RequestInit };

const stub = (routes: (url: string, init?: RequestInit) => unknown) => {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return ok(routes(url, init));
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("zone selection", () => {
  it("picks the longest matching zone, so a delegated subdomain wins", () => {
    // Writing api.shop.example.com into example.com would be shadowed by
    // shop.example.com's own nameservers and silently never resolve.
    const zones = [
      { id: "parent", name: "example.com" },
      { id: "child", name: "shop.example.com" },
    ];
    expect(zoneForHost("api.shop.example.com", zones)?.id).toBe("child");
    expect(zoneForHost("api.example.com", zones)?.id).toBe("parent");
  });

  it("matches on a label boundary, never a string suffix", () => {
    const zones = [{ id: "z", name: "example.com" }];
    expect(zoneForHost("api.notexample.com", zones)).toBeNull();
  });

  it("returns null when the credential covers nothing relevant", () => {
    expect(zoneForHost("api.example.com", [{ id: "z", name: "other.com" }])).toBeNull();
  });
});

describe("plan safety", () => {
  const desired: DesiredRecord[] = [
    { type: "TXT", name: "_hono-aep-challenge.shop.example.com", content: "token-abc", proxied: false },
    { type: "CNAME", name: "shop.example.com", content: "someone.github.io", proxied: false },
  ];

  it("plans creates when the names are empty", async () => {
    const { impl } = stub(() => []);
    const provider = cloudflareDns("cf-token", impl);
    const plan = await planRecords(provider, "zone1", desired, markerFor("p", "shop.example.com"));
    expect(plan.map((entry) => entry.action)).toEqual(["create", "create"]);
  });

  it("reports an existing identical record as present, and writes nothing", async () => {
    const { impl } = stub((url) =>
      url.includes("_hono-aep-challenge")
        ? [{ id: "r1", type: "TXT", name: "_hono-aep-challenge.shop.example.com", content: '"token-abc"' }]
        : [],
    );
    const provider = cloudflareDns("cf-token", impl);
    const plan = await planRecords(provider, "zone1", desired, "marker");
    expect(plan[0]!.action).toBe("present");

    const writes: Call[] = [];
    const applyStub = stub(() => ({}));
    await applyPlan(cloudflareDns("cf-token", applyStub.impl), "zone1", plan, "marker");
    writes.push(...applyStub.calls.filter((call) => call.init?.method === "POST"));
    expect(writes).toHaveLength(1); // only the CNAME, never the present TXT
  });

  it("REFUSES rather than replaces when someone else holds the name", async () => {
    // The property that matters most: a customer's existing record is never
    // collateral. A conflict must surface as a report, not a merge.
    const { impl } = stub((url) =>
      url.includes("name=shop.example.com")
        ? [{ id: "r9", type: "A", name: "shop.example.com", content: "203.0.113.9" }]
        : [],
    );
    const provider = cloudflareDns("cf-token", impl);
    const plan = await planRecords(provider, "zone1", desired, "marker");
    const cname = plan.find((entry) => entry.record.type === "CNAME")!;
    expect(cname.action).toBe("conflict");
    expect(cname.detail).toContain("CNAME cannot share a name");
  });

  it("never emits a delete or an update — apply only ever POSTs", async () => {
    const { impl } = stub((url) =>
      url.includes("name=shop.example.com")
        ? [{ id: "r9", type: "A", name: "shop.example.com", content: "203.0.113.9" }]
        : [],
    );
    const plan = await planRecords(cloudflareDns("t", impl), "zone1", desired, "marker");
    const applyStub = stub(() => ({}));
    await applyPlan(cloudflareDns("t", applyStub.impl), "zone1", plan, "marker");
    const methods = applyStub.calls.map((call) => call.init?.method ?? "GET");
    expect(methods).not.toContain("DELETE");
    expect(methods).not.toContain("PUT");
    expect(methods).not.toContain("PATCH");
  });

  it("treats a right-value wrong-proxy record as a conflict, not as present", async () => {
    // The failure this prevents is silent: an orange-clouded Pages CNAME
    // resolves fine and then never gets a certificate, and reporting it as
    // `present` would return applied:true for exactly the state the
    // proxied:false rule exists to forbid.
    const { impl } = stub((url) =>
      url.includes("name=shop.example.com")
        ? [{ id: "r1", type: "CNAME", name: "shop.example.com", content: "someone.github.io", proxied: true }]
        : [],
    );
    const plan = await planRecords(cloudflareDns("t", impl), "zone1", desired, "marker");
    const cname = plan.find((entry) => entry.record.type === "CNAME")!;
    expect(cname.action).toBe("conflict");
    expect(cname.detail).toContain("DNS-only");
  });

  it("still calls a matching record present when the proxy flag agrees", async () => {
    const { impl } = stub((url) =>
      url.includes("name=shop.example.com")
        ? [{ id: "r1", type: "CNAME", name: "shop.example.com", content: "someone.github.io", proxied: false }]
        : [],
    );
    const plan = await planRecords(cloudflareDns("t", impl), "zone1", desired, "marker");
    expect(plan.find((entry) => entry.record.type === "CNAME")!.action).toBe("present");
  });

  it("re-filters in code, so an ignored server-side filter cannot widen the plan", async () => {
    // If Cloudflare ignored `?name=`, an unfiltered zone would come back and
    // every unrelated record would look like a conflict at our name.
    const { impl } = stub(() => [
      { id: "mx", type: "MX", name: "example.com", content: "10 mail.example.com" },
      { id: "spf", type: "TXT", name: "example.com", content: '"v=spf1 -all"' },
    ]);
    const plan = await planRecords(cloudflareDns("t", impl), "zone1", desired, "marker");
    expect(plan.every((entry) => entry.action === "create")).toBe(true);
  });

  it("stamps our marker on everything it creates", async () => {
    const { impl } = stub(() => []);
    const plan = await planRecords(cloudflareDns("t", impl), "zone1", desired, "m");
    const applyStub = stub(() => ({}));
    await applyPlan(cloudflareDns("t", applyStub.impl), "zone1", plan, markerFor("proj", "shop.example.com"));
    const posted = applyStub.calls.filter((call) => call.init?.method === "POST");
    for (const call of posted) {
      expect(JSON.parse(String(call.init!.body)).comment).toBe("hono-aep:proj:shop.example.com");
    }
  });
});

describe("record-shape guards", () => {
  it("catches a CNAME sharing a name with another record before it is sent", () => {
    // The failure that made the original design 100%-fail on its happy path:
    // an ACME TXT and a DCV-delegation CNAME at one name, in one atomic
    // batch, which Cloudflare rejects wholesale.
    const clash: DesiredRecord[] = [
      { type: "TXT", name: "_acme-challenge.api.example.com", content: "x", proxied: false },
      { type: "CNAME", name: "_acme-challenge.api.example.com", content: "y.dcv.cloudflare.com", proxied: false },
    ];
    expect(cnameCollisions(clash)).toEqual(["_acme-challenge.api.example.com"]);
  });

  it("is quiet when every name is distinct", () => {
    const fine: DesiredRecord[] = [
      { type: "TXT", name: "_hono-aep-challenge.shop.example.com", content: "x", proxied: false },
      { type: "CNAME", name: "shop.example.com", content: "a.github.io", proxied: false },
    ];
    expect(cnameCollisions(fine)).toEqual([]);
  });
});

describe("provider errors", () => {
  it("turns a 403 into PERMISSION_DENIED without echoing the token", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }), {
        status: 403,
      })) as unknown as typeof fetch;
    const provider: DnsProvider = cloudflareDns("cf-super-secret-token", impl);
    const thrown = await provider.zones().then(() => null, (problem: unknown) => problem);
    expect((thrown as { body: { status: number; type: string } }).body).toMatchObject({
      status: 403,
      type: "PERMISSION_DENIED",
    });
    // The credential must not reach the caller through the error path — the
    // likeliest way a secret escapes is a message someone pasted a token into.
    expect(JSON.stringify(thrown)).not.toContain("cf-super-secret-token");
    expect(String((thrown as Error).message)).not.toContain("cf-super-secret-token");
  });
});
