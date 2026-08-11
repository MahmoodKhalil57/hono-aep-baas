# domains.md — a surface is reachable at its owner's domain

Status: v1 draft (2026-08-10). Depends: surface.md (the recursion law and
BASE), interface.md (studio/admin routes), surface.md §1 (nested addressing), site.md (`site.url`, hosted assets), secrets.md.

## 0. The claim

White-label is not a brand field — it is an **origin**. A reseller whose
customers see `mizan-gpp.the-montiapple.workers.dev` in every API URL, MCP
endpoint, admin link, and OAuth callback has not white-labelled anything.

So a project MAY declare its own domains, and every generated artifact
reflects them. This costs almost no new machinery: surface.md §1 already
requires every generator to be **base-relative**, so a custom domain is
simply another spelling of BASE — the flat path, the nested path, and the
custom origin are three ALIASES of one surface.

| alias | BASE |
| --- | --- |
| flat | `https://{platform}/v1/projects/saastarter3` |
| nested | `https://{platform}/v1/projects/bastarter/projects/saastarter3` |
| custom | `https://api.saastarter3.example.com` |

All three MUST address the same surface and MUST each generate documents
advertising **the alias the caller used**.

## 1. Two kinds of domain

| kind | names | reflects into |
| --- | --- | --- |
| `api` | the surface origin (`api.saastarter3.example.com`) | `{BASE}` itself: openapi `servers[]`, `{BASE}/mcp`, studio + admin URLs, auth base + OAuth callbacks, hosted site assets, CORS |
| `site` | the frontend origin (`saastarter3.example.com`) | `site.url` semantics: sitemap/robots/llms absolute links, OG card URLs, redirect targets, allowed origins |

A project MAY declare either, both, or neither. Declaring none is the
current behavior (platform path aliases only) and MUST keep working — the
domain is an addition, never a precondition.

## 2. Domains are a resource, not a config field

Ownership must be proved, so a domain has a LIFECYCLE and therefore belongs
in the definition plane as an ordinary AEP resource — not a free-text field
in the project doc. The studio gets a tab, MCP `describe` picks it up, and
policies gate it, all for free.

`{BASE}/domains/{host}`:

| field | notes |
| --- | --- |
| `host` | the id: a lowercase FQDN, no scheme, no port, no path |
| `kind` | `api` \| `site` |
| `state` | `PENDING` → `ACTIVE`, plus `FAILED` |
| `challenge` | output-only: the TXT value to publish |
| `verified_time` | output-only |

Lifecycle (AEP-216 states + AEP-136 custom verbs):

1. **Create** — the owner declares `{host, kind}`. The server mints a
   `challenge` and parks the row in `PENDING`. A `PENDING` domain routes
   NOTHING.
2. **`:verify`** — the server resolves `TXT _hono-aep-challenge.{host}` and
   requires the minted value. On match the row transitions to `ACTIVE`; on
   mismatch it stays `PENDING` with the reason (a retryable tool error, so
   an agent can self-correct).
3. **Delete** — releases the host immediately.

A host is globally unique across projects: the first ACTIVE claim wins, and
a second project claiming the same host is refused. Re-verification MAY run
periodically; a host whose TXT record disappears MUST fall back to
`PENDING` (stop routing) rather than continue serving.

## 3. Resolution: the worker maps Host → surface

> **Correction to the obvious mental model.** DNS cannot express this
> mapping on its own, for two independent reasons:
>
> 1. **DNS has no paths.** "point `api.saastarter3.example.com` at
>    `api.bastarter.example.com/projects/saastarter3`" is not a record any
>    registrar can hold. A CNAME maps a *name* to a *name*.
> 2. **`*.workers.dev` serves only its own hostname.** `CNAME … →
>    mizan-gpp.the-montiapple.workers.dev` does not make the worker answer
>    for your name; the request must be *routed* to the worker (§5).
>
> So DNS's only job is to deliver the request to the worker. The
> **worker** resolves `Host` → project, which is what this section
> specifies.

On each request the server resolves, in order:

1. `Host` matches an `ACTIVE` `api` domain → that project is the surface;
   `BASE = https://{host}`, with an EMPTY path prefix. A path prefix on top
   still nests: `https://api.bastarter.example.com/projects/saastarter3`
   addresses bastarter's child, with
   `BASE = https://api.bastarter.example.com/projects/saastarter3`.
2. Otherwise the platform path form (surface.md §1), unchanged.

The ancestor chain (surface.md §1.1) is unaffected: a custom domain simply
seeds the base with an origin instead of `/v1`. Both mechanisms feed the one
`BASE`, so a nested child reached through its parent's domain still
advertises the caller's alias.

Requirements:

1. A domain resolves ONLY when `ACTIVE`. `PENDING`/`FAILED` MUST 404 rather
   than fall through to the platform surface — silently serving an
   unverified host is how a takeover looks legitimate.
2. Resolution is a lookup, not a scan: an index keyed by host.
3. `Host` is attacker-controlled input; it selects a surface and MUST NOT be
   trusted for anything else (never for authorization).

## 4. What a domain must reflect

Because generators are base-relative, most of this is automatic — but it is
normative, and each is a conformance target:

| surface | requirement |
| --- | --- |
| OpenAPI | `servers[0].url` is the caller's BASE |
| MCP | the endpoint is `{BASE}/mcp`; reported paths stay BASE-relative |
| studio / admin | served at `{BASE}/studio`, `{BASE}/admin`; deep links use BASE |
| site assets | `robots.txt`, `sitemap.xml`, `llms.txt`, OG cards emit absolute URLs on the `site` domain when declared, else today's origin |
| auth | the pool's base URL becomes `{BASE}/auth`; **OAuth redirect URIs and any cookie domain follow it** — a provider console still holding the platform callback will fail, so the studio MUST surface the exact callback to register |
| CORS | the `site` domain is trusted for credentialed flows; the wildcard posture for public reads is unchanged (site.md §2a) |
| redirects | checkout/return/verification links target the `site` domain when declared |

## 5. Platform edge (operational reality)

Routing a name to the worker takes one of two mechanisms, and which one
applies depends on **who owns the zone**:

- **Zones on the platform's own Cloudflare account** (e.g. the operator's
  `example.com`): a Workers **Custom Domain** or a route such as
  `*.example.com/*`. Cheapest path; suits the operator's own subdomains for
  first-party projects and demos.
- **A customer's own domain, on their registrar** (the real white-label
  case): **Cloudflare for SaaS** custom hostnames — the customer points a
  CNAME at a platform-published target, and the platform provisions the
  certificate. TLS is the reason this cannot be pure DNS: someone must hold
  a certificate for the customer's name.

The spec is deliberately agnostic about which is configured; §2 verification
(a TXT record the owner can only publish if they control the zone) is what
authorizes either. TLS provisioning is an edge concern, but a domain MUST NOT
go `ACTIVE` before its certificate can serve, or the first request after
verification breaks.

## 6. Coordinates: `base` is the surface, `project` is identity

Today `.owner-creds.json` carries `{endpoint, project}` and every tool builds
`${endpoint}/v1/projects/${project}/…`. That forces a nested child to smuggle
a *route* through the `project` field
(`"project": "bastarter/projects/saastarter3"`) so the interpolation lands —
which is why one repo's `project` is an id and another's is a path. Identity
and addressing are conflated.

Normative change:

- **`base` is the surface BASE, complete.** Tools append resource paths
  directly (`{base}/collections`, `{base}/mcp`), never
  `/v1/projects/{project}`. `endpoint` remains the platform origin, and
  `endpoint` + `project` is the LEGACY composition kept for existing
  checkouts (`hono-aep-baas-cli/src/creds.ts` `surfaceBase()`).
- **`project` is the project's id only** — never a path.

| repo | `base` | `project` |
| --- | --- | --- |
| saastarter2 | `https://api.saastarter2.example.com` (or `https://{platform}/v1/projects/{id}`) | `{id}` |
| bastarter | `https://api.bastarter.example.com` | `bastarter` |
| saastarter3 | `https://api.saastarter3.example.com` (or `https://api.bastarter.example.com/projects/saastarter3`) | `saastarter3` |

Every alias in the `endpoint` column addresses the same surface, so a project
can move from a platform path to its own domain by editing ONE field — no
tool learns about domains. Migration MUST accept the current shape (a
`project` containing `/` keeps working) so existing checkouts do not break.

## 7. Security

1. **No routing without proof.** Unverified hosts never serve (§2, §3.1).
   Without this, a project could claim a name it does not own and stand up a
   convincing admin panel and OAuth callback on it.
2. **First ACTIVE claim wins**, and a host belongs to exactly one project.
3. **Lapse suspends.** Losing the TXT record returns the domain to
   `PENDING`; routing stops.
4. **`Host` never authorizes.** It selects a surface; the principal chain is
   unchanged (keys, owner-pool sessions, pool members).
5. A parent MAY set a child's domain (it owns the child, per interface.md
   §3) — that is how a reseller provisions customer domains — but the
   ownership proof is still required for the host itself.

## 8. Conformance

1. Flat, nested, and custom-domain aliases return byte-identical payloads and
   each advertise the caller's own BASE.
2. A `PENDING` domain 404s; an `ACTIVE` one serves; deleting it stops routing.
3. Two projects cannot both hold one host.
4. With no domain declared, every existing behavior is unchanged.
5. `{endpoint}` alone is sufficient for a tool to reach the surface — no
   `/v1/projects/{project}` interpolation anywhere.
6. A nested child reached through its parent's custom domain advertises the
   parent-domain path, not the platform path.

## 9. Non-goals v1

- Apex/root domains for the API (subdomain only; apex needs
  CNAME-flattening or ALIAS at the registrar).
- Automatic registrar integration — the owner publishes the TXT record.
- Per-domain themes or content variation: a domain is an alias for ONE
  surface, not a variant of it.
- Email sending domains (that is the `resend` config in services.md).
