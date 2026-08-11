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
| `email` | the mail domain (`mail.saastarter3.example.com`) | `services.email.from` — the address a project's transactional mail is sent from — and, when inbound is asked for, the address it RECEIVES at (services.md §3a, §3a.1c) |

`email` is the same resource with the same lifecycle; only the records
differ. `api` and `site` prove control with the platform's TXT challenge;
`email` publishes the **provider's** records (SPF/DKIM/DMARC for sending, MX
for receiving) and is `ACTIVE` when the provider reports them verified.
Ownership is proven the same way either path: you can only publish a record
in a zone you control.

Sending and receiving are tracked independently on the one `email` domain —
inbound additionally requires the domain to be a zone in a Cloudflare
account, which sending does not, so a project can legitimately have one
without the other (services.md §3a.1c).

A project MAY declare either, both, or neither. Declaring none is the
current behavior (platform path aliases only) and MUST keep working — the
domain is an addition, never a precondition.

## 1a. The free fallback: a hostname before you own one

A domain costs money and takes a DNS round-trip to prove. Neither should
stand between someone and a working API, so **every project gets a hostname
on the platform's own zone, for free, the moment it exists**:

```
{project}-api.{platform-zone}      e.g. saastarter2-api.saastemly.com
```

This is **derived, never declared**. There is no `domains` row, no
challenge, no `:verify` call, and nothing to revoke individually — ownership
is not in question because the platform is the registrant. That single fact
is what makes the fallback both free to hand out and centrally withdrawable.

**Only `kind: api`.** A wildcard resolves to exactly ONE origin, and every
project's frontend is a different deployment — so there is nothing coherent
a wildcard could mean for `site`. Projects keep their host's free URL
(`{user}.github.io/{repo}`) until they bring a domain, which costs nothing
and is consistent with site.md: the baas hosts what the frontend READS,
never the frontend. `email` has its own fallback — a shared sending alias on
the platform's pool domain (services.md §3a), which is a different mechanism
because mail reputation is pooled, not routed.

**Precedence.** The derived host is resolved FIRST (§3), before the `domains`
table is consulted — otherwise a hostile row could shadow it. That does not
compete with custom domains, because the two namespaces cannot overlap: the
fallback grammar matches only `{label}-api.{zone}`, and a custom host on the
platform zone (`api.{project}.{zone}`) has a dot in its label, so it never
does. Bringing a real domain is therefore an addition, never a migration: the
fallback host keeps working, and both are aliases of one surface under §0.

### 1a.1 Why not a free registrar (Freenom and friends)

Rejected, with reasons, so this is not re-litigated:

1. **It cannot be automated.** Freenom stopped new registrations in 2023
   during Meta's lawsuit and exposes no supported provisioning API. A
   fallback that requires a human is not a fallback.
2. **Free TLDs are blocklisted wholesale.** `.tk`/`.ml`/`.ga`/`.cf`/`.gq`
   carry enough abuse that mail providers reject them by TLD — so the tier
   that most needs deliverability would have the least, defeating its own
   purpose.
3. **Browsers and corporate filters flag them**, which is the opposite of
   the reassurance a first deploy needs.

One owned zone costs ~$12/yr TOTAL and yields unlimited customer subdomains
with none of the above. The economics are not close.

### 1a.2 Substrate constraints that shape the grammar

The odd-looking `{project}-api` — rather than the prettier
`{project}.api.{zone}` — is forced by two measured platform facts:

| constraint | consequence |
| --- | --- |
| **Workers Custom Domains do not support wildcard DNS records** (`workers/configuration/routing/custom-domains.mdx`); an incoming request must match the registered hostname exactly | The fallback CANNOT be a Custom Domain. It is a wildcard **route** (`*.{zone}/*`) plus a wildcard **DNS** record, and TLS therefore comes from the ZONE certificate rather than a per-hostname one |
| A zone's free Universal SSL certificate covers the apex and `*.{zone}` — **one label deep**. Deeper wildcards need Advanced Certificate Manager (a paid zone add-on) | `saastarter2.api.saastemly.com` is two deep and would fail TLS on the free path. `saastarter2-api.saastemly.com` is one deep and is covered |

Both grammars MUST resolve, so enabling ACM later is a DNS change and not a
code change. Deployments that own no zone leave the suffix unset and the
fallback is simply off.

Also note DNS wildcards are **leftmost-label only** — `*.{zone}` is a legal
record and `*-api.{zone}` is not. The record is therefore the broad
`*.{zone}`, and the `-api` discrimination happens in the worker's route
pattern and in resolution.

### 1a.3 Reserved names

The zone apex and the platform's own subdomains (`api`, `www`, `studio`,
`admin`, `mail`, and any host with a real DNS record) MUST NOT resolve to a
project. Exact records beat the wildcard at the DNS layer, and resolution
refuses the apex and bare subdomains besides — handing a platform hostname
to a tenant is a takeover with extra steps.

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

1. `Host` matches the platform zone's fallback grammar (§1a) → that project
   is the surface, `BASE = https://{host}` with an EMPTY path prefix. No
   verification, because the platform owns the zone; an unknown label 404s
   downstream like any other missing project.
2. `Host` is otherwise ON the platform zone and reserved (§1a.3) → not a
   surface; no `domains` row may serve it.
3. `Host` matches an `ACTIVE` `api` domain → that project is the surface, same
   BASE shape. A path prefix on top still nests:
   `https://api.bastarter.example.com/projects/saastarter3` addresses
   bastarter's child, with
   `BASE = https://api.bastarter.example.com/projects/saastarter3`.
4. `Host` is CLAIMED but not `ACTIVE` → 404 (requirement 1 below). It MUST
   NOT fall through to the platform path form; serving an unverified name is
   what a takeover looks like.
5. Otherwise the platform path form (surface.md §1), unchanged.

> **Why the derived host is resolved FIRST**, rather than after the table as
> an earlier draft of this spec had it. A `domains` row must never be able to
> shadow a derived host: an ACTIVE row on `{victim}-api.{zone}` would steal
> that tenant's free surface, and a merely PENDING one would 404 it — a denial
> of service costing one call. Deriving first makes both unreachable, and
> costs nothing, because the two namespaces cannot overlap: the fallback
> grammar matches only `{label}-api.{zone}`, while a custom host on the
> platform zone (`api.{project}.{zone}`) has a dot in its label and so never
> matches. Claims on the zone are refused at the door regardless (§1a.3).

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
6. **The fallback zone puts every tenant on ONE registrable domain**
   (§1a), which is a shared cookie jar: any page on
   `a-api.saastemly.com` can write a cookie scoped to `saastemly.com` and
   `b-api.saastemly.com` will send it. Two consequences, both binding:
   - Platform and project cookies MUST be **host-only** (no `Domain=`
     attribute). A `Domain=saastemly.com` cookie is readable by every
     tenant, and one on the console's own host is a session-fixation
     vector against the platform itself.
   - The platform zone SHOULD be submitted to the **Public Suffix List**,
     which is what makes browsers refuse cross-tenant cookie writes rather
     than relying on our discipline. This is why `vercel.app`,
     `netlify.app` and `pages.dev` are on it, and it is the reason a
     dedicated zone for the fallback is preferable to reusing a zone that
     also carries the marketing site and the console.
     PSL listing takes weeks and is not a launch blocker — the host-only
     rule is what holds until it lands.
7. **The fallback is not a proof of anything.** A project's fallback host is
   derived from its id, so knowing an id is enough to name the host. That is
   fine — the host selects a surface and never authorizes (§7.4) — but it
   means project ids appear in URLs and should not be treated as secrets.

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
7. A new project is reachable at `{project}-api.{platform-zone}` with no
   `domains` row, no DNS work, and no verification step.
8. A verified custom domain for the same project takes precedence over its
   fallback host, and BOTH keep serving — adding a domain never breaks the
   host that was already in someone's config.
9. The fallback matches on a LABEL boundary: `{project}-api.evil{zone}` does
   not resolve.
10. The zone apex, the platform's own subdomains, and site-shaped hosts
    (`{project}.{zone}`) do not resolve to a project.
11. With no platform zone configured, the fallback is off and every host
    falls through to the platform path form.

## 9. Non-goals v1

- Apex/root domains for the API (subdomain only; apex needs
  CNAME-flattening or ALIAS at the registrar).
- Automatic registrar integration — the owner publishes the TXT record.
- Per-domain themes or content variation: a domain is an alias for ONE
  surface, not a variant of it.
- ~~Email sending domains~~ — **reopened and folded in** as `kind: email`
  above, because it is the same question (does this project control that
  name?) with a different record set. Keeping it out would have meant a
  second verification mechanism for one concept.
