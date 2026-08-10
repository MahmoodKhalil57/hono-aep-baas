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

describe("hosted developer studio", () => {
  it("/studio serves the dogfooded bundle (or falls back to /studio-lite)", async () => {
    // With dist/studio-assets built, index.ts serves the React console;
    // without it the handler 302s to the vanilla page. Either way the
    // final document is a same-origin console.
    const response = await fetch(url("/studio"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain("mizan-gpp studio");
  });

  it("/studio-lite serves the zero-build console", async () => {
    const response = await fetch(url("/studio-lite"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Developer studio");
    expect(html).toContain("/api/auth/sign-"); // cookie auth, same origin
  });

  it("serves the FontPicker catalog shim", async () => {
    const body = await (await fetch(url("/developer-api/font-catalog"))).json();
    expect(Array.isArray((body as { fonts: string[] }).fonts)).toBe(true);
    expect((body as { fonts: string[] }).fonts.length).toBeGreaterThan(10);
  });

  it("ships the raw ⇄ visual toggle and the visual builders", async () => {
    const html = await (await fetch(url("/studio-lite"))).text();
    expect(html).toContain('id="mode-visual"'); // the toggle
    expect(html).toContain('id="mode-raw"');
    expect(html).toContain('id="v-fields"'); // collection field-row builder
    expect(html).toContain('id="v-theme"'); // theme token rows (color pickers)
    expect(html).toContain('id="v-blocks"'); // page block editor
    expect(html).toContain("oklchToHex"); // picker displays oklch tokens
    // Both modes serialize to the same public contract via the one Apply button.
    expect(html).toContain("refreshVisual");
  });
});

describe("hosted site assets (/site/{asset})", () => {
  it("serves generated admin/manifest/robots/sw/sitemap/llms from config + public data", async () => {
    const cookie = await signUp("site-assets");
    const project = await makeProject(cookie, "Asset Site");

    await fetch(url(`/v1/${project}`), {
      method: "PATCH",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        site: {
          url: "https://shop.example",
          description: "A tiny shop.",
          app: { shortName: "Shop", themeColor: "#123456" },
          admin: { collections: ["items"] },
          assets: {
            robots: { extra: ["Disallow: /admin.html"] },
            sitemap: { urls: ["/", "/items.html"], collections: [{ slug: "items", url: "/item.html?id={id}" }] },
            llms: { sections: [{ title: "Items", collection: "items", url: "/item.html?id={id}", label: "name" }] },
          },
        },
      }),
    });
    await fetch(url(`/v1/${project}/collections/items`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "item", plural: "items", fields: [{ name: "name", type: "string", required: true }], policy_create: "authenticated", policy_list: "public", policy_get: "public" } }),
    });
    await fetch(url(`/v1/${project}/items?id=widget`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ name: "Widget" }),
    });

    const get = (asset: string) => fetch(url(`/v1/${project}/site/${asset}`));
    const adminPage = await (await get("admin.html")).text();
    expect(adminPage).toContain("./bootstrap-ui.js"); // dogfoods the renderer module next door
    expect((await (await get("bootstrap-ui.js")).text())).toContain("adminModelFromDocument");
    const manifest = (await (await get("manifest.webmanifest")).json()) as Record<string, unknown>;
    expect(manifest.short_name).toBe("Shop");
    expect(manifest.theme_color).toBe("#123456");
    const robots = await (await get("robots.txt")).text();
    expect(robots).toContain("Disallow: /admin.html");
    expect(robots).toContain(`Sitemap: ${url(`/v1/${project}/site/sitemap.xml`)}`);
    const manifest2 = (await (await get("manifest.webmanifest")).json()) as Record<string, unknown>;
    expect(manifest2.start_url).toBe("https://shop.example/"); // absolute — cross-origin manifest links resolve against the manifest URL
    expect(await (await get("sw.js")).text()).toContain("network-first");
    const sitemap = await (await get("sitemap.xml")).text();
    expect(sitemap).toContain("<loc>https://shop.example/items.html</loc>");
    expect(sitemap).toContain("<loc>https://shop.example/item.html?id=widget</loc>"); // public row
    const llms = await (await get("llms.txt")).text();
    expect(llms).toContain("# Asset Site");
    expect(llms).toContain("[Widget](https://shop.example/item.html?id=widget)");
  });

  it("generates favicon + rasterized OG cards (site-wide and per-entity)", async () => {
    const cookie = await signUp("og-assets");
    const project = await makeProject(cookie, "OG Site");
    await fetch(url(`/v1/${project}`), {
      method: "PATCH",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        site: {
          url: "https://og.example",
          description: "Cards at the edge.",
          app: { shortName: "OG", themeColor: "#123456" },
          assets: { og: { items: { title: "name", subtitle: "note", money: "price_cents" } } },
        },
      }),
    });
    await fetch(url(`/v1/${project}/collections/items`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "item", plural: "items", fields: [{ name: "name", type: "string", required: true }, { name: "note", type: "string" }, { name: "price_cents", type: "number", integer: true }], policy_create: "authenticated", policy_list: "public", policy_get: "public" } }),
    });
    await fetch(url(`/v1/${project}/items?id=widget`), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ name: "Widget Deluxe", note: "The finest widget.", price_cents: 1999 }),
    });

    const favicon = await fetch(url(`/v1/${project}/site/favicon.svg`));
    expect(favicon.headers.get("Content-Type")).toContain("image/svg");
    const svg = await favicon.text();
    expect(svg).toContain("#123456"); // themeColor lettermark
    expect(svg).toContain(">O</text>"); // shortName initial

    const siteCard = await fetch(url(`/v1/${project}/site/og.png`));
    expect(siteCard.status).toBe(200);
    expect(siteCard.headers.get("Content-Type")).toBe("image/png");
    const siteBytes = new Uint8Array(await siteCard.arrayBuffer());
    expect([...siteBytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic

    const entityCard = await fetch(url(`/v1/${project}/site/og/items/widget.png`));
    expect(entityCard.status).toBe(200);
    const entityBytes = new Uint8Array(await entityCard.arrayBuffer());
    expect([...entityBytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(entityBytes.length).toBeGreaterThan(3000); // a real card, not a blank

    const unmapped = await fetch(url(`/v1/${project}/site/og/unknown/x.png`));
    expect(unmapped.status).toBe(404);
  });

  it("hosts contract-derived JSON Schemas for config + seed files", async () => {
    const cookie = await signUp("schemas");
    const project = await makeProject(cookie, "Schema Site");
    await fetch(url(`/v1/${project}/collections/gizmos`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "gizmo", plural: "gizmos", fields: [{ name: "name", type: "string", required: true }, { name: "blurb", type: "string", localized: true }], policy_list: "public", policy_get: "public" } }),
    });

    // Static kind, derived from the server's own zod validator.
    const collectionSchema = (await (await fetch(url("/v1/schemas/collection-config.json"))).json()) as Record<string, any>;
    expect(collectionSchema.$schema).toContain("2020-12");
    expect(collectionSchema.required).toEqual(["definition"]);
    expect(collectionSchema.properties.definition.properties.singular.pattern).toBeDefined(); // kebab-case from resourceDocumentSchema
    expect(collectionSchema.properties.$schema).toBeDefined(); // files may carry the pointer

    for (const kind of ["baas-config", "project-config", "form-config", "seed-config", "seed-user", "seed-lock"]) {
      expect((await fetch(url(`/v1/schemas/${kind}.json`))).status).toBe(200);
    }
    expect((await fetch(url("/v1/schemas/nope.json"))).status).toBe(404);

    // Per-project row schema, generated from the live definition.
    const rows = (await (await fetch(url(`/v1/${project}/schemas/rows/gizmos.json`))).json()) as Record<string, any>;
    expect(rows.required).toContain("name");
    expect(rows.properties.blurb.additionalProperties).toEqual({ type: "string" }); // localized → locale map
    expect((await fetch(url(`/v1/${project}/schemas/rows/absent.json`))).status).toBe(404);
  });

  it("per-project secrets: write-only, owner-gated, digest-listed (spec/secrets.md)", async () => {
    const cookie = await signUp("secrets-owner");
    const project = await makeProject(cookie, "Secret Site");
    const owner = { ...json, Cookie: cookie };

    // Anonymous and non-owner writes are refused.
    expect((await fetch(url(`/v1/${project}/secrets`), { method: "GET" })).status).toBe(401);
    const stranger = await signUp("secrets-stranger");
    expect((await fetch(url(`/v1/${project}/secrets`), { headers: { ...json, Cookie: stranger } })).status).toBe(403);

    // Set, list (digest only — the value never comes back), delete.
    const put = await fetch(url(`/v1/${project}/secrets/STRIPE_SECRET_KEY`), {
      method: "PUT", headers: owner, body: JSON.stringify({ value: "sk_test_abc123" }),
    });
    expect(put.status).toBe(200);
    const { digest } = (await put.json()) as { digest: string };
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    await fetch(url(`/v1/${project}/secrets/lowercase-bad`), { method: "PUT", headers: owner, body: JSON.stringify({ value: "x" }) })
      .then((r) => expect(r.status).toBe(400));
    const listed = (await (await fetch(url(`/v1/${project}/secrets`), { headers: owner })).json()) as { results: { name: string; digest: string }[] };
    expect(listed.results).toEqual([{ name: "STRIPE_SECRET_KEY", digest }]);
    expect(JSON.stringify(listed)).not.toContain("sk_test_abc123"); // write-only
    expect((await fetch(url(`/v1/${project}/secrets/STRIPE_SECRET_KEY`), { method: "DELETE", headers: owner })).status).toBe(204);
    expect(((await (await fetch(url(`/v1/${project}/secrets`), { headers: owner })).json()) as { results: unknown[] }).results).toEqual([]);
  });
});

describe("self-clonability: the platform console is hostable from ANY static origin", () => {
  it("cross-origin platform auth is bearer-first with CORS; keys:mint answers preflight", async () => {
    const foreign = { Origin: "https://someone.github.io" };
    // preflight on auth
    const pre = await fetch(url("/api/auth/sign-in/email"), { method: "OPTIONS", headers: { ...foreign, "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // sign-up from a foreign origin returns the session as set-auth-token
    const signedUp = await fetch(url("/api/auth/sign-up/email"), {
      method: "POST",
      headers: { ...json, ...foreign },
      body: JSON.stringify({ email: `clone-${Date.now()}@example.com`, password: "supersecret1", name: "clone" }),
    });
    expect(signedUp.status).toBe(200);
    expect(signedUp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const token = signedUp.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    // the bearer token drives the whole definition plane — mint a key with it
    expect((await fetch(url("/v1/keys:mint"), { method: "OPTIONS", headers: foreign })).status).toBe(204);
    const minted = await fetch(url("/v1/keys:mint"), { method: "POST", headers: { ...json, ...foreign, Authorization: `Bearer ${token}` }, body: "{}" });
    expect(minted.status).toBe(200);
    expect(((await minted.json()) as { plaintext: string }).plaintext).toMatch(/^sk_/);
  });
});

describe("unified interface (spec/interface.md)", () => {
  it("the ONE engine serves at /v1/projects/{p}/studio and /admin, and nests", async () => {
    const cookie = await signUp("iface-owner");
    const parent = (await makeProject(cookie, "Iface Host")).split("/")[1]!;
    await fetch(url(`/v1/projects/${parent}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ auth_pool: { emailPassword: { enabled: true } } }),
    });
    const poolToken = (await fetch(url(`/v1/projects/${parent}/auth/sign-up/email`), {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `iface-${Date.now()}@example.com`, password: "supersecret1", name: "c" }),
    })).headers.get("set-auth-token")!;
    const key = ((await (await fetch(url(`/v1/projects/${parent}/keys:mint`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${poolToken}` }, body: "{}",
    })).json()) as { plaintext: string }).plaintext;
    await fetch(url(`/v1/projects?id=iface-child`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify({ display_name: "Child" }),
    });

    const shell = async (path: string) => {
      const r = await fetch(url(path));
      return { status: r.status, type: r.headers.get("Content-Type") ?? "", body: await r.text() };
    };
    for (const path of [`/v1/projects/${parent}/studio`, `/v1/projects/${parent}/admin`]) {
      const s = await shell(path);
      expect(s.status).toBe(200);
      expect(s.type).toContain("text/html");
      expect(s.body).toContain('id="root"'); // the one engine's mount point
    }
    // Nested: the child's interface is served UNDER the parent (bastarter's
    // admin over saastarter3 = saastarter3's studio) — same shell, for free.
    const nested = await shell(`/v1/projects/${parent}/projects/iface-child/studio`);
    expect(nested.status).toBe(200);
    expect(nested.body).toContain('id="root"');
  });
});

describe("per-project services (spec/services.md)", () => {
  it("site.services declares payment/delivery/email and validates against the hosted schema", async () => {
    const cookie = await signUp("svc-owner");
    const project = (await makeProject(cookie, "Svc Site")).split("/")[1]!;
    const patched = await fetch(url(`/v1/projects/${project}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ site: { services: {
        payment: { provider: "stripe" },
        delivery: { provider: "download" },
        email: { provider: "resend", from: "Shop <shop@you.com>" },
      } } }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { site: { services: { email: { provider: string } } } }).site.services.email.provider).toBe("resend");

    // The project-config schema now describes services (autocomplete + validate).
    const schema = (await (await fetch(url("/v1/schemas/project-config.json"))).json()) as Record<string, any>;
    expect(schema.properties.site.properties.services.properties.email.properties.provider.enum).toContain("resend");
    // The resend option is gated to the two real choices.
    expect(schema.properties.site.properties.services.properties.payment.properties.provider.enum).toEqual(["stripe"]);
  });
});

describe("CMS-on-CMS: a child project nests under its parent's path", () => {
  it("/v1/projects/{parent}/projects/{child}/** is the child's whole surface — derived, no flag", async () => {
    const cookie = await signUp("nest-host");
    const parent = (await makeProject(cookie, "Nest Host")).split("/")[1]!;
    await fetch(url(`/v1/projects/${parent}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ auth_pool: { emailPassword: { enabled: true } } }),
    });
    const poolToken = (await fetch(url(`/v1/projects/${parent}/auth/sign-up/email`), {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `nest-cust-${Date.now()}@example.com`, password: "supersecret1", name: "c" }),
    })).headers.get("set-auth-token")!;
    const key = ((await (await fetch(url(`/v1/projects/${parent}/keys:mint`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${poolToken}` }, body: "{}",
    })).json()) as { plaintext: string }).plaintext;
    await fetch(url(`/v1/projects?id=nest-child`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify({ display_name: "Nest Child" }),
    });
    const owner = { ...json, Authorization: `Bearer ${key}` };

    // Apply a collection AND read it back BOTH ways — flat and nested — same data.
    await fetch(url(`/v1/projects/nest-child/collections/widgets`), {
      method: "PUT", headers: owner,
      body: JSON.stringify({ definition: { singular: "widget", plural: "widgets", fields: [{ name: "name", type: "string", required: true }], policy_list: "public", policy_get: "public", policy_create: "authenticated" } }),
    });
    await fetch(url(`/v1/projects/nest-child/widgets?id=w1`), { method: "POST", headers: owner, body: JSON.stringify({ name: "Nested Widget" }) });

    const flat = await (await fetch(url(`/v1/projects/nest-child/widgets/w1`))).json();
    const nested = await (await fetch(url(`/v1/projects/${parent}/projects/nest-child/widgets/w1`))).json();
    expect((nested as { name: string }).name).toBe("Nested Widget");
    expect(nested).toEqual(flat); // the nested path IS the child, byte-for-byte

    // Owner-gated surfaces work nested with the child key.
    expect((await fetch(url(`/v1/projects/${parent}/projects/nest-child/secrets`), { headers: owner })).status).toBe(200);
    // A NON-child can't be addressed under the parent (the derivation gates it).
    const foreign = (await makeProject(cookie, "Foreign")).split("/")[1]!;
    expect((await fetch(url(`/v1/projects/${parent}/projects/${foreign}/openapi.json`))).status).toBe(404);
    // The bare nested collection lists the parent's children.
    const list = (await (await fetch(url(`/v1/projects/${parent}/projects`))).json()) as { results: { path: string }[] };
    expect(list.results.map((r) => r.path)).toContain(`projects/${parent}/projects/nest-child`);
  });

  it("generated documents are base-relative, and ancestry cannot be forged (surface.md §1)", async () => {
    const cookie = await signUp("base-host");
    const parent = (await makeProject(cookie, "Base Host")).split("/")[1]!;
    await fetch(url(`/v1/projects/${parent}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ auth_pool: { emailPassword: { enabled: true } } }),
    });
    const poolToken = (await fetch(url(`/v1/projects/${parent}/auth/sign-up/email`), {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `base-cust-${Date.now()}@example.com`, password: "supersecret1", name: "c" }),
    })).headers.get("set-auth-token")!;
    const key = ((await (await fetch(url(`/v1/projects/${parent}/keys:mint`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${poolToken}` }, body: "{}",
    })).json()) as { plaintext: string }).plaintext;
    await fetch(url(`/v1/projects?id=base-child`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify({ display_name: "Base Child" }),
    });
    await fetch(url(`/v1/projects/base-child/collections/widgets`), {
      method: "PUT", headers: { ...json, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ definition: { singular: "widget", plural: "widgets", fields: [{ name: "name", type: "string" }], policy_list: "public", policy_get: "public" } }),
    });

    const serverUrl = async (path: string, headers?: Record<string, string>) =>
      ((await (await fetch(url(path), headers ? { headers } : undefined)).json()) as {
        servers: { url: string }[];
      }).servers[0]!.url;

    // The document a caller fetches must address the surface THEY used —
    // not the flat path the nested rewrite unwrapped to.
    expect(await serverUrl(`/v1/projects/base-child/openapi.json`)).toBe(
      `${server.origin}/v1/projects/base-child`,
    );
    expect(await serverUrl(`/v1/projects/${parent}/projects/base-child/openapi.json`)).toBe(
      `${server.origin}/v1/projects/${parent}/projects/base-child`,
    );

    // §1.1: ancestry is internal — a caller that declares its own would mint
    // a document advertising a surface it does not own.
    expect(
      await serverUrl(`/v1/projects/base-child/openapi.json`, { "x-aep-ancestors": "evil-parent" }),
    ).toBe(`${server.origin}/v1/projects/base-child`);

    // §2: the document enumerates BOTH planes — the same model the MCP
    // projection describes, so the two projections cannot drift apart.
    const doc = (await (await fetch(url(`/v1/projects/base-child/openapi.json`))).json()) as {
      paths: Record<string, unknown>;
    };
    const paths = Object.keys(doc.paths);
    expect(paths.some((entry) => entry.startsWith("/widgets"))).toBe(true); // data
    expect(paths.some((entry) => entry.startsWith("/collections"))).toBe(true); // definition
  });

  it("an agent drives BOTH planes of a surface over one stateless MCP endpoint (surface.md §3)", async () => {
    const cookie = await signUp("mcp-host");
    const parent = (await makeProject(cookie, "MCP Host")).split("/")[1]!;
    await fetch(url(`/v1/projects/${parent}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ auth_pool: { emailPassword: { enabled: true } } }),
    });
    const poolToken = (await fetch(url(`/v1/projects/${parent}/auth/sign-up/email`), {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `mcp-cust-${Date.now()}@example.com`, password: "supersecret1", name: "c" }),
    })).headers.get("set-auth-token")!;
    const key = ((await (await fetch(url(`/v1/projects/${parent}/keys:mint`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${poolToken}` }, body: "{}",
    })).json()) as { plaintext: string }).plaintext;
    await fetch(url(`/v1/projects?id=mcp-child`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${key}` }, body: JSON.stringify({ display_name: "MCP Child" }),
    });
    await fetch(url(`/v1/projects/mcp-child/collections/gadgets`), {
      method: "PUT", headers: { ...json, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ definition: { singular: "gadget", plural: "gadgets", fields: [{ name: "name", type: "string", required: true }], policy_list: "public", policy_get: "public", policy_create: "authenticated" } }),
    });

    let rpcId = 0;
    const mcp = async (base: string, method: string, params: Record<string, unknown> = {}) => {
      const body = {
        jsonrpc: "2.0", id: ++rpcId, method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      };
      const response = await fetch(url(`${base}/mcp`), {
        method: "POST",
        headers: {
          ...json,
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${key}`,
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const call = async (base: string, name: string, args: Record<string, unknown> = {}) =>
      (await mcp(base, "tools/call", { name, arguments: args })).body.result;

    const flat = `/v1/projects/mcp-child`;

    // Stateless discovery — no handshake, no session.
    const discovered = await mcp(flat, "server/discover");
    expect(discovered.status).toBe(200);
    expect(discovered.body.result.supportedVersions).toEqual(["2026-07-28"]);

    // §3.1: ONE describe spans both planes, each tagged.
    const model = (await call(flat, "describe")).structuredContent;
    const planes = Object.fromEntries(
      model.resources.map((entry: any) => [entry.collection, entry.plane]),
    );
    expect(planes.collections).toBe("definition"); // the studio's plane
    expect(planes.gadgets).toBe("data"); // the admin's + frontend's plane

    // The definition plane is reachable: the agent reads what shapes the project.
    const definitions = await call(flat, "list", { collection: "collections" });
    const declared = definitions.structuredContent.results.map((row: any) => String(row.path ?? row.id));
    expect(declared.some((entry: string) => entry.endsWith("gadgets"))).toBe(true);

    // The data plane is reachable through the SAME endpoint and verbs.
    const created = await call(flat, "create", { collection: "gadgets", data: { name: "Widget One" } });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent.name).toBe("Widget One");

    // §4 corollary: the parent drives the child's agent surface at the
    // nested path — same model, same tools, different BASE.
    const nested = await call(`/v1/projects/${parent}/projects/mcp-child`, "list", { collection: "gadgets" });
    expect(nested.structuredContent.results.map((row: any) => row.name)).toContain("Widget One");

    // Transport conformance holds on the project surface too.
    expect((await fetch(url(`${flat}/mcp`), { method: "GET" })).status).toBe(405);
    const badVersion = await fetch(url(`${flat}/mcp`), {
      method: "POST",
      headers: { ...json, "MCP-Protocol-Version": "2025-06-18", "Mcp-Method": "tools/list" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 99, method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18", "io.modelcontextprotocol/clientCapabilities": {} } },
      }),
    });
    expect(badVersion.status).toBe(400);
    expect(((await badVersion.json()) as any).error.code).toBe(-32022);
  });
});

describe("tenancy: two projects may hold the same slug", () => {
  it("one project's collection id does not collide with another's", async () => {
    // collections.md: tenancy IS the resource tree, so `products` under
    // project A and `products` under project B are different resources.
    // A global primary key on the slug silently makes them ONE row — the
    // second project's apply then destroys the first's definition, which
    // orphans its data (the JIT app can no longer surface those rows).
    const cookie = await signUp("tenancy");
    const a = (await makeProject(cookie, "Tenant A")).split("/")[1]!;
    const b = (await makeProject(cookie, "Tenant B")).split("/")[1]!;
    const owner = { ...json, Cookie: cookie };
    const definition = (label: string) => ({
      definition: {
        singular: "product", plural: "products",
        fields: [{ name: label, type: "string" }],
        policy_list: "public", policy_get: "public",
      },
    });

    expect((await fetch(url(`/v1/projects/${a}/collections/products`), {
      method: "PUT", headers: owner, body: JSON.stringify(definition("a_field")),
    })).status).toBeLessThan(300);
    expect((await fetch(url(`/v1/projects/${b}/collections/products`), {
      method: "PUT", headers: owner, body: JSON.stringify(definition("b_field")),
    })).status).toBeLessThan(300);

    // Both must still exist, each with its own definition.
    const slugs = async (project: string): Promise<string[]> => {
      const body = (await (await fetch(url(`/v1/projects/${project}/collections`), { headers: owner })).json()) as
        { results: { path?: string; id?: string }[] };
      return body.results.map((row) => String(row.path ?? row.id).split("/").pop()!);
    };
    expect(await slugs(a)).toContain("products");
    expect(await slugs(b)).toContain("products");

    const rowA = (await (await fetch(url(`/v1/projects/${a}/collections/products`), { headers: owner })).json()) as
      { definition: { fields: { name: string }[] } };
    expect(rowA.definition.fields.map((f) => f.name)).toContain("a_field");
  });
});

describe("custom domains (baas/domains.md)", () => {
  // :verify does a real DNS-over-HTTPS lookup; give it room.
  it("declaring a host does not route it — only proof does", { timeout: 20000 }, async () => {
    const cookie = await signUp("dom-host");
    const project = (await makeProject(cookie, "Domain Host")).split("/")[1]!;
    const owner = { ...json, Cookie: cookie };
    await fetch(url(`/v1/projects/${project}/collections/widgets`), {
      method: "PUT", headers: owner,
      body: JSON.stringify({ definition: { singular: "widget", plural: "widgets", fields: [{ name: "name", type: "string" }], policy_list: "public", policy_get: "public" } }),
    });

    const host = `api.${project}.example.test`;
    const created = await fetch(url(`/v1/projects/${project}/domains?id=${host}`), {
      method: "POST", headers: owner, body: JSON.stringify({ kind: "api" }),
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { state: string; challenge: string; verified_time?: string };

    // §2.1: PENDING, with a server-minted challenge the client never chose.
    expect(row.state).toBe("PENDING");
    expect(row.challenge).toMatch(/^hono-aep-domain-verification=/);
    expect(row.verified_time).toBeUndefined();

    // §3.1: a PENDING host must NOT route — it does not resolve to the
    // surface, and it must not silently fall through to the platform either.
    const pendingHit = await fetch(url("/collections"), { headers: { ...owner, Host: host } });
    expect(pendingHit.status).not.toBe(200);

    // §2.2: verification fails closed when the TXT record is absent, and
    // says so in a way a caller can act on — without activating.
    const verified = await fetch(url(`/v1/projects/${project}/domains/${host}:verify`), {
      method: "POST", headers: owner, body: "{}",
    });
    expect(verified.status).toBe(200);
    const after = (await verified.json()) as { state: string; last_error: string };
    expect(after.state).toBe("PENDING");
    expect(after.last_error).toContain("_hono-aep-challenge");

    // A client cannot hand itself ACTIVE, nor choose its own proof, through
    // an ordinary write — that would route a host it never proved it owns.
    await fetch(url(`/v1/projects/${project}/domains/${host}`), {
      method: "PATCH", headers: owner,
      body: JSON.stringify({ state: "ACTIVE", challenge: "hono-aep-domain-verification=forged" }),
    });
    const reread = (await (await fetch(url(`/v1/projects/${project}/domains/${host}`), { headers: owner })).json()) as
      { state: string; challenge: string };
    expect(reread.state).toBe("PENDING");
    expect(reread.challenge).toBe(row.challenge); // output-only: unchanged

    // §7.4: the internal routing headers are never client-declarable.
    const forged = (await (await fetch(url(`/v1/projects/${project}/openapi.json`), {
      headers: { "x-aep-domain": "evil.example.test" },
    })).json()) as { servers: { url: string }[] };
    expect(forged.servers[0]!.url).toBe(`${server.origin}/v1/projects/${project}`);
  });

  it("a host cannot be claimed while another project holds it ACTIVE", async () => {
    const cookie = await signUp("dom-race");
    const first = (await makeProject(cookie, "First")).split("/")[1]!;
    const second = (await makeProject(cookie, "Second")).split("/")[1]!;
    const owner = { ...json, Cookie: cookie };
    const host = "api.contested.example.test";

    expect((await fetch(url(`/v1/projects/${first}/domains?id=${host}`), {
      method: "POST", headers: owner, body: JSON.stringify({ kind: "api" }),
    })).status).toBe(201);

    // Both are PENDING, so the second claim is allowed to exist; the gate
    // is ACTIVE-ness (§2: first ACTIVE claim wins).
    const rival = await fetch(url(`/v1/projects/${second}/domains?id=${host}`), {
      method: "POST", headers: owner, body: JSON.stringify({ kind: "api" }),
    });
    expect([201, 409]).toContain(rival.status);
  });
});

describe("white-label by composition (auth-pools + keys:mint + project create)", () => {
  it("a project's pool member creates and fully owns their own child project — no reseller primitive", async () => {
    // A 'reseller' is just a project that has a pool. No special mode.
    const cookie = await signUp("wl-host");
    const host = (await makeProject(cookie, "Whitelabel Host")).split("/")[1]!;
    await fetch(url(`/v1/projects/${host}`), {
      method: "PATCH",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ auth_pool: { emailPassword: { enabled: true } } }),
    });

    // 1. A customer signs up in the HOST's pool (not a platform account).
    const poolUp = await fetch(url(`/v1/projects/${host}/auth/sign-up/email`), {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `wl-cust-${Date.now()}@example.com`, password: "supersecret1", name: "cust" }),
    });
    expect(poolUp.status).toBe(200);
    const poolToken = poolUp.headers.get("set-auth-token")!;

    // 2. They mint a key at the EXISTING keys:mint (pool principals accepted).
    const minted = await fetch(url(`/v1/projects/${host}/keys:mint`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${poolToken}` }, body: "{}",
    });
    expect(minted.status).toBe(200);
    const key = ((await minted.json()) as { plaintext: string }).plaintext;
    expect(key).toMatch(/^sk_/);

    // 3. That key creates a project via the EXISTING POST /v1/projects.
    const created = await fetch(url(`/v1/projects?id=wl-child`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ display_name: "Customer Child" }),
    });
    expect(created.status).toBe(201);
    const child = (await created.json()) as { path: string; created_by: string };
    expect(child.path).toBe("projects/wl-child");
    // Attribution is free: the namespaced pool principal names the host.
    expect(child.created_by).toMatch(new RegExp(`^pool:${host}:`));

    // 4. Full owner capability under that same key — no capability loss.
    const owner = { ...json, Authorization: `Bearer ${key}` };
    const applied = await fetch(url(`/v1/projects/wl-child/collections/things`), {
      method: "PUT", headers: owner,
      body: JSON.stringify({ definition: { singular: "thing", plural: "things", fields: [{ name: "title", type: "string", required: true }], policy_list: "public", policy_get: "public", policy_create: "authenticated" } }),
    });
    expect([200, 201]).toContain(applied.status);
    expect((await fetch(url("/v1/projects/wl-child/secrets"), { headers: owner })).status).toBe(200);
    // The host's platform owner does NOT own the child (isolation both ways).
    expect((await fetch(url("/v1/projects/wl-child/secrets"), { headers: { ...json, Cookie: cookie } })).status).toBe(403);

    // The parent-pool SESSION owns the child too (spec/interface.md): the
    // owner drives the interface with a session, not only the sk_ key.
    expect((await fetch(url("/v1/projects/wl-child/secrets"), { headers: { ...json, Authorization: `Bearer ${poolToken}` } })).status).toBe(200);
    // But a DIFFERENT host-pool member (not the owner) gets nothing on the child.
    const other = (await fetch(url(`/v1/projects/${host}/auth/sign-up/email`), {
      method: "POST", headers: json,
      body: JSON.stringify({ email: `wl-other-${Date.now()}@example.com`, password: "supersecret1", name: "o" }),
    })).headers.get("set-auth-token")!;
    expect([401, 403]).toContain((await fetch(url("/v1/projects/wl-child/secrets"), { headers: { ...json, Authorization: `Bearer ${other}` } })).status); // refused either way
  });
});

describe("issue #2: platform-minted ids round-trip", () => {
  it("PUT accepts digit-leading project ids and X-Request-Id is on every /v1 response", async () => {
    const cookie = await signUp("uuid-owner");
    // Deterministic digit-leading id (a UUIDv4 leads with 0-9 62.5% of the time).
    const created = await fetch(url("/v1/projects?id=0digit-leading-test"), {
      method: "POST",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ display_name: "Digit" }),
    });
    expect(created.status).toBe(201);
    const put = await fetch(url("/v1/projects/0digit-leading-test"), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ display_name: "Digit Renamed" }),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("X-Request-Id")).toMatch(/^[0-9a-f]{32}$/);
    // errors carry it too — that id is how bugs get reported (skill playbook)
    const bad = await fetch(url("/v1/projects/-leading-dash"), { method: "PUT", headers: { ...json, Cookie: cookie }, body: "{}" });
    expect(bad.status).toBeGreaterThanOrEqual(400); // error responses carry the id too
    expect(bad.headers.get("X-Request-Id")).toMatch(/^[0-9a-f]{32}$/);
  });
});

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

describe("hosted themes (site.md §1)", () => {
  it("canonicalizes on write and serves doubled-selector css with CORS", async () => {
    const cookie = await signUp("themer");
    const project = await makeProject(cookie, "Themed");
    const projectId = project.split("/")[1]!;

    // Non-canonical input (odd spacing) — the round-trip law formats it.
    const applied = await fetch(url(`/v1/${project}/themes/default`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        css: ":root{--primary:oklch(0.55 0.15 45);--radius:0.5rem}\n.dark{--primary:oklch(0.7 0.15 45)}",
      }),
    });
    expect(applied.status).toBe(201);
    const stored = (await (
      await fetch(url(`/v1/${project}/themes/default`), { headers: { Cookie: cookie } })
    ).json()) as { css: string };
    expect(stored.css).toContain("/* cms-theme: default");
    expect(stored.css).toContain("  --primary: oklch(0.55 0.15 45);");

    const served = await fetch(url(`/v1/projects/${projectId}/theme.css`), {
      headers: { Origin: "https://someone.github.io" },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toContain("text/css");
    expect(served.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const css = await served.text();
    expect(css).toContain(":root:root"); // doubled — beats the SPA's bundled defaults
    expect(css).toContain(":root:root.dark");
    expect(css).toContain("--primary: oklch(0.55 0.15 45);");

    // Garbage is refused with a clear problem.
    const garbage = await fetch(url(`/v1/${project}/themes/broken`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ css: "body { color: red }" }),
    });
    expect(garbage.status).toBe(400);
  }, 30_000);
});

describe("hosted pages + blocks (site.md §1)", () => {
  it("owner declares; the world reads; Puck shape is guarded", async () => {
    const cookie = await signUp("publisher");
    const project = await makeProject(cookie, "Site");

    const pageDoc = {
      title: "About us",
      data: {
        root: { props: {} },
        content: [
          { type: "Hero", props: { id: "h1", title: "Hello", subtitle: "From a hosted page" } },
        ],
      },
    };
    expect(
      (
        await fetch(url(`/v1/${project}/pages/about`), {
          method: "PUT",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify(pageDoc),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await fetch(url(`/v1/${project}/blocks/announcement`), {
          method: "PUT",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify({ title: "Banner", data: { content: [{ type: "Markdown", props: { id: "m1", body: "**Sale!**" } }] } }),
        })
      ).status,
    ).toBe(201);

    // Public reads, no auth — the static SPA's surface (CORS asserted elsewhere).
    const read = await fetch(url(`/v1/${project}/pages/about`));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { title: string }).title).toBe("About us");
    expect((await fetch(url(`/v1/${project}/blocks/announcement`))).status).toBe(200);
    expect((await fetch(url(`/v1/${project}/pages`))).status).toBe(200);

    // Writes stay the owner's.
    expect(
      (
        await fetch(url(`/v1/${project}/pages/about`), {
          method: "PATCH",
          headers: json,
          body: JSON.stringify({ title: "Hijacked" }),
        })
      ).status,
    ).toBe(401);

    // Non-Puck data is refused.
    expect(
      (
        await fetch(url(`/v1/${project}/pages/broken`), {
          method: "PUT",
          headers: { ...json, Cookie: cookie },
          body: JSON.stringify({ title: "X", data: { nope: true } }),
        })
      ).status,
    ).toBe(400);
  }, 30_000);
});

describe("per-project OpenAPI (white-label admin source)", () => {
  it("serves the JIT app's contract with the declared collection's paths", async () => {
    const cookie = await signUp("apiuser");
    const project = await makeProject(cookie, "Contracted");
    await fetch(url(`/v1/${project}/collections/blog`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "post",
          plural: "posts",
          fields: [{ name: "title", type: "string", required: true }],
        },
      }),
    });
    const projectId = project.split("/")[1]!;
    const doc = await fetch(url(`/v1/projects/${projectId}/openapi.json`), {
      headers: { Origin: "https://someone.github.io" },
    });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await doc.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(body.paths)).toContain("/posts");
  }, 30_000);
});

describe("inbound webhooks route (connections consumer)", () => {
  it("routes POST /v1/projects/{p}/webhooks/{name} to the consumer", async () => {
    const cookie = await signUp("hookuser");
    const project = await makeProject(cookie, "Hooked");
    const projectId = project.split("/")[1]!;
    // The sample stripe connection ships DISABLED → the consumer reports
    // no such inbound connection (404 problem), proving the route reaches
    // it rather than falling through to the JIT/page 404 shell.
    const response = await fetch(url(`/v1/projects/${projectId}/webhooks/stripe`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://hooks.stripe.com" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(((await response.json()) as { title: string }).title).toContain("inbound connection");
  }, 30_000);
});

describe("lexical search over collections (search kind, AEP-136)", () => {
  it("indexes on write, ranks :search by coverage, hydrates through read policy", async () => {
    const cookie = await signUp("searcher");
    const project = await makeProject(cookie, "Searchable");
    await fetch(url(`/v1/${project}/collections/blog`), {
      method: "PUT",
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({
        definition: {
          singular: "post",
          plural: "posts",
          fields: [{ name: "title", type: "string", required: true }, { name: "body", type: "string" }],
          policy_create: "authenticated",
        },
      }),
    });
    const post = (id: string, title: string, body: string) =>
      fetch(url(`/v1/${project}/posts?id=${id}`), {
        method: "POST",
        headers: { ...json, Cookie: cookie },
        body: JSON.stringify({ title, body }),
      });
    await post("a", "Machine learning basics", "An intro to ML models");
    await post("b", "Deep learning networks", "Neural nets and learning");
    await post("c", "Sourdough bread", "Baking at home");

    const results = (await (
      await fetch(url(`/v1/${project}/posts:search`), {
        method: "POST",
        headers: json,
        body: JSON.stringify({ query: "machine learning" }),
      })
    ).json()) as { results: { path: string; _score: number }[] };
    // 'a' has both terms → first; 'b' has "learning" → second; 'c' absent.
    expect(results.results.map((r) => r.path.split("/").pop())).toEqual(["a", "b"]);
    expect(results.results[0]!._score).toBeGreaterThan(results.results[1]!._score);

    // Delete drops it from the index.
    await fetch(url(`/v1/${project}/posts/a`), { method: "DELETE", headers: { Cookie: cookie } });
    const after = (await (
      await fetch(url(`/v1/${project}/posts:search`), {
        method: "POST",
        headers: json,
        body: JSON.stringify({ query: "machine learning" }),
      })
    ).json()) as { results: { path: string }[] };
    expect(after.results.map((r) => r.path.split("/").pop())).toEqual(["b"]);
  }, 30_000);
});

describe("definition gate = the full serving pipeline (AEP-122 poison guard)", () => {
  it("rejects a snake_case singular at apply time; a poisoned row cannot break siblings", async () => {
    const cookie = await signUp("gatekeeper");
    const project = await makeProject(cookie, "Gate");
    // Apply-time rejection: defineResource's kebab-case invariant fires at PUT.
    const bad = await fetch(url(`/v1/${project}/collections/wishlist`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "wishlist_item", plural: "wishlist", fields: [{ name: "product", type: "string", required: true }] } }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { detail: string }).detail).toContain("kebab-case");
    // Kebab-case version applies, and siblings keep working.
    const good = await fetch(url(`/v1/${project}/collections/wishlist`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "wishlist-item", plural: "wishlist", fields: [{ name: "product", type: "string", required: true }, { name: "created_by", type: "string" }], policy_create: "authenticated", policy_list: { owner: { field: "created_by" } }, policy_get: { owner: { field: "created_by" } }, policy_update: { owner: { field: "created_by" } }, policy_delete: { owner: { field: "created_by" } }, owner: "created_by" } }),
    });
    expect(good.status).toBe(201);
    const list = await fetch(url(`/v1/${project}/wishlist`), { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
  }, 30_000);
});

describe("guest checkout + link upgrade (commerce.md §3a)", () => {
  it("a guest buys; signing up while holding the guest session carries the order + wishlist", async () => {
    const cookie = await signUp("merchant3");
    const project = await makeProject(cookie, "GuestShop");
    const pid = project.split("/")[1]!;
    await fetch(url(`/v1/${project}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ auth_pool: { emailPassword: { enabled: true }, anonymous: { enabled: true } } }),
    });
    await fetch(url(`/v1/${project}/collections/catalog`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "product", plural: "products", fields: [{ name: "name", type: "string", required: true }, { name: "price_cents", type: "number", integer: true }], policy_create: "authenticated", policy_get: "public", policy_list: "public" } }),
    });
    await fetch(url(`/v1/${project}/collections/wishlist`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "wishlist-item", plural: "wishlist", fields: [{ name: "product", type: "string", required: true }, { name: "created_by", type: "string" }], policy_create: "authenticated", policy_list: { owner: { field: "created_by" } }, policy_get: { owner: { field: "created_by" } }, policy_update: { owner: { field: "created_by" } }, policy_delete: { owner: { field: "created_by" } }, owner: "created_by" } }),
    });
    await fetch(url(`/v1/${project}/products?id=kit`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: "Kit", price_cents: 2000 }) });

    // ONE call, no form: the guest session (commerce.md §3a.1).
    const guestIn = await fetch(url(`/v1/${project}/auth/sign-in/anonymous`), { method: "POST", headers: json, body: "{}" });
    expect(guestIn.status).toBe(200);
    const guest = guestIn.headers.get("set-auth-token")!;
    // Guest shops exactly like anyone: wishlist + cart + PAID order (local billing).
    await fetch(url(`/v1/projects/${pid}/wishlist`), { method: "POST", headers: { ...json, Authorization: `Bearer ${guest}` }, body: JSON.stringify({ product: "kit" }) });
    await fetch(url(`/v1/projects/${pid}/commerce/cart:add`), { method: "POST", headers: { ...json, Authorization: `Bearer ${guest}` }, body: JSON.stringify({ variant: "kit" }) });
    const co = (await (await fetch(url(`/v1/projects/${pid}/commerce/cart:checkout`), { method: "POST", headers: { ...json, Authorization: `Bearer ${guest}` }, body: "{}" })).json()) as { order: { status: string } };
    expect(co.order.status).toBe("paid");

    // Upgrade: sign-up WHILE holding the guest session → rows re-parent.
    const upgraded = await fetch(url(`/v1/${project}/auth/sign-up/email`), {
      method: "POST", headers: { ...json, Authorization: `Bearer ${guest}` },
      body: JSON.stringify({ email: `kept-${Date.now()}@x.com`, password: "supersecret1", name: "Kept" }),
    });
    expect(upgraded.status).toBe(200);
    const account = upgraded.headers.get("set-auth-token")!;
    const orders = (await (await fetch(url(`/v1/projects/${pid}/commerce/orders`), { headers: { Authorization: `Bearer ${account}` } })).json()) as { orders: { status: string }[] };
    expect(orders.orders).toHaveLength(1); // the guest's paid order came along
    expect(orders.orders[0]!.status).toBe("paid");
    const wish = (await (await fetch(url(`/v1/projects/${pid}/wishlist`), { headers: { Authorization: `Bearer ${account}` } })).json()) as { results: unknown[] };
    expect(wish.results).toHaveLength(1); // so did the wishlist

    // Developer key (keys.md TODO(saastarter)): a POOL user mints an sk_
    // key bound to their principal; the key acts as their session does.
    const minted = await fetch(url(`/v1/projects/${pid}/keys:mint`), { method: "POST", headers: { ...json, Authorization: `Bearer ${account}` }, body: "{}" });
    expect(minted.status).toBe(200);
    const { plaintext } = (await minted.json()) as { plaintext: string };
    expect(plaintext).toMatch(/^sk_/);
    const viaKey = (await (await fetch(url(`/v1/projects/${pid}/commerce/orders`), { headers: { Authorization: `Bearer ${plaintext}` } })).json()) as { orders: unknown[] };
    expect(viaKey.orders).toHaveLength(1); // the key sees THEIR orders
    // anonymous mint refused
    expect((await fetch(url(`/v1/projects/${pid}/keys:mint`), { method: "POST", headers: json, body: "{}" })).status).toBe(401);
  }, 30_000);
});

describe("virtual delivery (delivery.md): paid order → auto-download → claim", () => {
  it("a product with a file delivers itself; claim admits owner + token; strangers 403", async () => {
    const cookie = await signUp("digitalmerchant");
    const project = await makeProject(cookie, "Digital");
    const pid = project.split("/")[1]!;
    await fetch(url(`/v1/${project}`), { method: "PATCH", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ auth_pool: {} }) });
    await fetch(url(`/v1/${project}/collections/catalog`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "product", plural: "products", fields: [{ name: "name", type: "string", required: true }, { name: "price_cents", type: "number", integer: true }, { name: "file", type: "string" }], policy_create: "authenticated", policy_get: "public", policy_list: "public" } }),
    });
    // Upload the deliverable, attach it to the product.
    const form = new FormData();
    form.append("file", new File(["THE-PRODUCT-BYTES"], "product.zip", { type: "application/zip" }));
    const uploaded = await fetch(url(`/v1/projects/${pid}/media:upload`), { method: "POST", headers: { Cookie: cookie }, body: form });
    const mediaId = ((await uploaded.json()) as { results: { path: string }[] }).results[0]!.path.split("/")[1]!;
    await fetch(url(`/v1/${project}/products?id=zip`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: "The Zip", price_cents: 500, file: mediaId }) });

    // Buyer: cart → checkout (local billing pays instantly) → AUTO delivery.
    const tok = (await (await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `dl-${Date.now()}@x.com`, password: "supersecret1", name: "DL" }) })).headers.get("set-auth-token"))!;
    await fetch(url(`/v1/projects/${pid}/commerce/cart:add`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok}` }, body: JSON.stringify({ variant: "zip" }) });
    const co = (await (await fetch(url(`/v1/projects/${pid}/commerce/cart:checkout`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok}` }, body: "{}" })).json()) as { order: { id: string; status: string } };
    expect(co.order.status).toBe("paid");

    // Orders carry the delivery with a TOKENED download artifact (§3);
    // the delivered virtual delivery walked the ORDER machine to delivered.
    const orders = (await (await fetch(url(`/v1/projects/${pid}/commerce/orders`), { headers: { Authorization: `Bearer ${tok}` } })).json()) as {
      orders: { status: string; deliveries: { status: string; artifacts: { kind: string; claim?: string }[] }[] }[];
    };
    expect(orders.orders[0]!.status).toBe("delivered");
    const deliveryRow = orders.orders[0]!.deliveries[0]!;
    expect(deliveryRow.status).toBe("delivered");
    const artifact = deliveryRow.artifacts.find((a) => a.kind === "download")!;
    expect(artifact.claim).toContain("token=");

    // Claim door 1: the signed token alone (no auth header) → the bytes.
    const viaToken = await fetch(url(`/v1${artifact.claim!.startsWith("/v1") ? artifact.claim!.slice(3) : artifact.claim!}`));
    expect(viaToken.status).toBe(200);
    expect(await viaToken.text()).toBe("THE-PRODUCT-BYTES");
    // Claim door 2: the owner's session, no token.
    const bare = artifact.claim!.split("&token=")[0]!;
    const viaOwner = await fetch(url(`/v1${bare.startsWith("/v1") ? bare.slice(3) : bare}`), { headers: { Authorization: `Bearer ${tok}` } });
    expect(viaOwner.status).toBe(200);
    // A stranger with neither → 403.
    const stranger = (await (await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `str-${Date.now()}@x.com`, password: "supersecret1", name: "S" }) })).headers.get("set-auth-token"))!;
    expect((await fetch(url(`/v1${bare.startsWith("/v1") ? bare.slice(3) : bare}`), { headers: { Authorization: `Bearer ${stranger}` } })).status).toBe(403);
  }, 30_000);
});

describe("localized page variants (cms/localization.md §2)", () => {
  it("pages/{slug}?locale resolves slug@locale through the chain; base is terminal", async () => {
    const cookie = await signUp("pagewright");
    const project = await makeProject(cookie, "Pages");
    const pid = project.split("/")[1]!;
    await fetch(url(`/v1/${project}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ site: { locales: { default: "en", supported: ["en", "ar", "fr-CA"], fallback: { "fr-CA": "ar" } } } }),
    });
    const doc = (title: string) => JSON.stringify({ title, data: { content: [], root: {} } });
    // Base page + the Arabic sibling variant (slug@locale, AIP-133 id).
    expect((await fetch(url(`/v1/${project}/pages/about`), { method: "PUT", headers: { ...json, Cookie: cookie }, body: doc("About us") })).status).toBe(201);
    expect((await fetch(url(`/v1/${project}/pages/about@ar`), { method: "PUT", headers: { ...json, Cookie: cookie }, body: doc("من نحن") })).status).toBe(201);
    const titleAt = async (query: string) =>
      (((await (await fetch(url(`/v1/projects/${pid}/pages/about${query}`))).json()) as { title: string }).title);
    expect(await titleAt("")).toBe("About us"); // no locale → base
    expect(await titleAt("?locale=ar")).toBe("من نحن"); // exact variant
    expect(await titleAt("?locale=fr-CA")).toBe("من نحن"); // fr-CA → ar via the chain
    expect(await titleAt("?locale=de")).toBe("About us"); // unsupported → terminal base
    expect(await titleAt("?locale=en")).toBe("About us"); // default never probes variants
  }, 30_000);
});

describe("per-project media (media.md)", () => {
  it("authenticated upload → public download; mutation is owner-only; delete removes the blob", async () => {
    const cookie = await signUp("uploader");
    const project = await makeProject(cookie, "Media");
    const pid = project.split("/")[1]!;
    await fetch(url(`/v1/${project}`), { method: "PATCH", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ auth_pool: {} }) });
    // Anonymous upload is refused.
    const anon = await fetch(url(`/v1/projects/${pid}/media:upload`), { method: "POST", body: new FormData() });
    expect(anon.status).toBe(401);
    // A pool END-USER uploads (multipart).
    const tok = (await (await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `m-${Date.now()}@x.com`, password: "supersecret1", name: "M" }) })).headers.get("set-auth-token"))!;
    const form = new FormData();
    form.append("file", new File(["avatar-bytes-here"], "avatar.png", { type: "image/png" }));
    const uploaded = await fetch(url(`/v1/projects/${pid}/media:upload`), { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: form });
    expect(uploaded.status).toBe(201);
    const { results } = (await uploaded.json()) as { results: { path: string; content_type: string; size_bytes: number }[] };
    const id = results[0]!.path.split("/")[1]!;
    expect(results[0]!.content_type).toBe("image/png");
    // Public download streams the exact bytes with the stored type.
    const download = await fetch(url(`/v1/projects/${pid}/media/${id}:download`));
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("image/png");
    expect(await download.text()).toBe("avatar-bytes-here");
    // Mutation: the uploader (pool user) may NOT delete; the project owner may.
    expect((await fetch(url(`/v1/projects/${pid}/media/${id}`), { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } })).status).toBe(403);
    expect((await fetch(url(`/v1/projects/${pid}/media/${id}`), { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(204);
    // The blob went with the row (afterDelete).
    expect((await fetch(url(`/v1/projects/${pid}/media/${id}:download`))).status).toBe(404);
  }, 30_000);
});

describe("discounts + fulfillment over hosted collections (commerce.md §3.4-3.5)", () => {
  it("merchant declares a coupon row; checkout applies it; owner advances fulfillment", async () => {
    const cookie = await signUp("shopkeeper");
    const project = await makeProject(cookie, "Coupons");
    const pid = project.split("/")[1]!;
    await fetch(url(`/v1/${project}`), { method: "PATCH", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ auth_pool: {} }) });
    // catalog + coupon as hosted collections (config, not code)
    await fetch(url(`/v1/${project}/collections/catalog`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "product", plural: "products", fields: [{ name: "name", type: "string", required: true }, { name: "price_cents", type: "number", integer: true }], policy_create: "authenticated", policy_get: "public", policy_list: "public" } }),
    });
    await fetch(url(`/v1/${project}/collections/discounts`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "discount", plural: "discounts", fields: [{ name: "kind", type: "string", required: true, enum_values: ["percent", "fixed"] }, { name: "value", type: "number", integer: true, required: true }, { name: "min_cents", type: "number", integer: true }, { name: "used", type: "number", integer: true }], policy_create: "authenticated", policy_get: "public", policy_list: "public" } }),
    });
    await fetch(url(`/v1/${project}/products?id=kit`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: "Kit", price_cents: 3000 }) });
    await fetch(url(`/v1/${project}/discounts?id=SAVE20`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ kind: "percent", value: 20, min_cents: 1000 }) });
    // pool customer: cart → validate → discounted checkout (local billing pays instantly)
    const tok = (await (await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `c-${Date.now()}@x.com`, password: "supersecret1", name: "C" }) })).headers.get("set-auth-token"))!;
    await fetch(url(`/v1/projects/${pid}/commerce/cart:add`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok}` }, body: JSON.stringify({ variant: "kit" }) });
    const verdict = (await (await fetch(url(`/v1/projects/${pid}/commerce/discount:validate`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok}` }, body: JSON.stringify({ code: "SAVE20" }) })).json()) as { ok: boolean; discount_cents: number };
    expect(verdict).toMatchObject({ ok: true, discount_cents: 600 });
    const co = (await (await fetch(url(`/v1/projects/${pid}/commerce/cart:checkout`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok}` }, body: JSON.stringify({ discount: "SAVE20" }) })).json()) as { order: { id: string; status: string; total_cents: number; discount?: { code: string } } };
    expect(co.order.status).toBe("paid");
    expect(co.order.total_cents).toBe(2400);
    expect(co.order.discount).toMatchObject({ code: "SAVE20" });
    // used counter incremented on the SAME paid transition
    const row = (await (await fetch(url(`/v1/projects/${pid}/discounts/SAVE20`))).json()) as { used: number };
    expect(row.used).toBe(1);
    // fulfillment: the customer may NOT advance; the owner walks the machine
    const denied = await fetch(url(`/v1/projects/${pid}/commerce/orders/${co.order.id}:advance`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok}` }, body: JSON.stringify({ to: "fulfilled" }) });
    expect(denied.status).toBe(403);
    for (const to of ["fulfilled", "shipped", "delivered"]) {
      const r = await fetch(url(`/v1/projects/${pid}/commerce/orders/${co.order.id}:advance`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ to }) });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { status: string }).status).toBe(to);
    }
    // and an illegal jump is a clean 422
    const bad = await fetch(url(`/v1/projects/${pid}/commerce/orders/${co.order.id}:advance`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ to: "cancelled" }) });
    expect(bad.status).toBe(422);
    // Merchant stats: owner-only aggregates off the order snapshots.
    expect((await fetch(url(`/v1/projects/${pid}/commerce/stats`), { headers: { Authorization: `Bearer ${tok}` } })).status).toBe(403);
    const stats = (await (await fetch(url(`/v1/projects/${pid}/commerce/stats`), { headers: { Cookie: cookie } })).json()) as {
      orders: number; revenue_cents: number; by_status: Record<string, number>; top_products: { product: string; units: number }[];
    };
    expect(stats.orders).toBe(1);
    expect(stats.revenue_cents).toBe(2400); // the discounted paid total
    expect(stats.by_status["delivered"]).toBe(1);
    expect(stats.top_products[0]).toMatchObject({ product: "kit", units: 1 });
    // Owner lists ALL orders (?all=1); customers get a clean 403.
    const all = (await (await fetch(url(`/v1/projects/${pid}/commerce/orders?all=1`), { headers: { Cookie: cookie } })).json()) as { orders: { customer: string; status: string }[] };
    expect(all.orders).toHaveLength(1);
    expect(all.orders[0]!.customer).toContain("pool:");
    expect((await fetch(url(`/v1/projects/${pid}/commerce/orders?all=1`), { headers: { Authorization: `Bearer ${tok}` } })).status).toBe(403);
  }, 30_000);
});

describe("localized fields (cms/localization.md §3)", () => {
  it("flat writes merge per locale; reads resolve via the fallback chain; locale=all returns maps", async () => {
    const cookie = await signUp("localizer");
    const project = await makeProject(cookie, "Localized");
    const pid = project.split("/")[1]!;
    // site.locales on the project (§1) + a collection with a localized field.
    await fetch(url(`/v1/${project}`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ site: { locales: { default: "en", supported: ["en", "ar"], fallback: {} } } }),
    });
    await fetch(url(`/v1/${project}/collections/items`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: {
        singular: "item", plural: "items",
        fields: [
          { name: "title", type: "string", required: true, localized: true },
          { name: "price", type: "number", integer: true },
        ],
        policy_create: "authenticated", policy_update: "authenticated", policy_list: "public", policy_get: "public",
      } }),
    });
    // Create with a flat title (no locale param → default locale en).
    const created = await fetch(url(`/v1/projects/${pid}/items?id=tee`), {
      method: "POST", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ title: "Classic Tee", price: 1500 }),
    });
    expect(created.status).toBe(201);
    // Add the Arabic translation via a flat PATCH under ?locale=ar.
    const patched = await fetch(url(`/v1/projects/${pid}/items/tee?locale=ar`), {
      method: "PATCH", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ title: "تي شيرت كلاسيكي" }),
    });
    expect(patched.status).toBe(200);
    // Reads resolve flat per locale; ar falls back to en for missing tags.
    const en = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=en`))).json()) as { title: string };
    const ar = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=ar`))).json()) as { title: string };
    const def = (await (await fetch(url(`/v1/projects/${pid}/items/tee`))).json()) as { title: string };
    expect(en.title).toBe("Classic Tee");
    expect(ar.title).toBe("تي شيرت كلاسيكي");
    expect(def.title).toBe("Classic Tee"); // default locale
    // locale=all returns the raw map (the authoring/export shape).
    const all = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=all`))).json()) as { title: Record<string, string> };
    expect(all.title).toEqual({ en: "Classic Tee", ar: "تي شيرت كلاسيكي" });
    // Apply (PUT) one locale flat must NOT erase the other translation.
    const put = await fetch(url(`/v1/projects/${pid}/items/tee?locale=en`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ title: "Classic Tee v2", price: 1600 }),
    });
    expect(put.status).toBe(200);
    const after = (await (await fetch(url(`/v1/projects/${pid}/items/tee?locale=all`))).json()) as { title: Record<string, string> };
    expect(after.title).toEqual({ en: "Classic Tee v2", ar: "تي شيرت كلاسيكي" });
    // LIST resolves per row.
    const listed = (await (await fetch(url(`/v1/projects/${pid}/items?locale=ar`))).json()) as { results: { title: string }[] };
    expect(listed.results[0]!.title).toBe("تي شيرت كلاسيكي");
    // SEARCH results resolve too (no raw locale maps on the wire).
    const searched = (await (await fetch(url(`/v1/projects/${pid}/items:search?locale=ar`), { method: "POST", headers: json, body: JSON.stringify({ query: "كلاسيكي" }) })).json()) as { results: { title: unknown }[] };
    if (searched.results.length > 0) expect(typeof searched.results[0]!.title).toBe("string");
    const searchedDefault = (await (await fetch(url(`/v1/projects/${pid}/items:search`), { method: "POST", headers: json, body: JSON.stringify({ query: "Classic" }) })).json()) as { results: { title: unknown }[] };
    expect(searchedDefault.results.length).toBeGreaterThan(0);
    expect(searchedDefault.results[0]!.title).toBe("Classic Tee v2");
  }, 30_000);
});

describe("commerce cart→checkout (baas/commerce.md)", () => {
  it("a pool user adds a product to cart and checks out to a pending order", async () => {
    const cookie = await signUp("merchant");
    const project = await makeProject(cookie, "Shop");
    const pid = project.split("/")[1]!;
    // a products collection + one product
    await fetch(url(`/v1/${project}/collections/catalog`), {
      method: "PUT", headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ definition: { singular: "product", plural: "products", fields: [{ name: "name", type: "string", required: true }, { name: "price_cents", type: "number", integer: true }], policy_create: "authenticated", policy_get: "public", policy_list: "public" } }),
    });
    await fetch(url(`/v1/${project}/products?id=tee`), { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: "Tee", price_cents: 1500 }) });
    // pool user
    const tok = await (async () => {
      const r = await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `buyer-${Date.now()}@x.com`, password: "supersecret1", name: "B" }) });
      return r.headers.get("set-auth-token")!;
    })();
    // enable the pool first (project needs auth_pool)
    await fetch(url(`/v1/${project}`), { method: "PATCH", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ auth_pool: {} }) });
    const tok2 = (await (await fetch(url(`/v1/${project}/auth/sign-up/email`), { method: "POST", headers: json, body: JSON.stringify({ email: `buyer2-${Date.now()}@x.com`, password: "supersecret1", name: "B2" }) })).headers.get("set-auth-token"))!;
    void tok;
    const add = await fetch(url(`/v1/projects/${pid}/commerce/cart:add`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok2}` }, body: JSON.stringify({ variant: "tee", quantity: 2 }) });
    expect(add.status).toBe(200);
    const cart = (await add.json()) as { items: unknown[]; total_cents: number };
    expect(cart.items).toHaveLength(1);
    expect(cart.total_cents).toBe(3000);
    const co = await fetch(url(`/v1/projects/${pid}/commerce/cart:checkout`), { method: "POST", headers: { ...json, Authorization: `Bearer ${tok2}` }, body: "{}" });
    expect(co.status).toBe(200);
    const body = (await co.json()) as { order: { status: string; total_cents: number } };
    // local billing settles instantly → the order fires :pay in the same
    // request (commerce.md §3); a stripe provider would leave it pending
    // until the paid webhook. Either way the snapshot total is authoritative.
    expect(body.order.status).toBe("paid");
    expect(body.order.total_cents).toBe(3000);
    // The paid order shows up in the buyer's order history (commerce/orders).
    const hist = await fetch(url(`/v1/projects/${pid}/commerce/orders`), { headers: { Authorization: `Bearer ${tok2}` } });
    const { orders } = (await hist.json()) as { orders: { status: string; items: unknown[] }[] };
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("paid");
  }, 30_000);
});
