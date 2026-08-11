# services.md — per-project service selection

Status: v1 (2026-08-10). Depends: secrets.md, commerce.md, gateway.md,
delivery.md, notifications (suite kind), sync.md (the `$schema` convention).

## 0. The gap this closes

The OPERATOR configures services once (the deployed worker's service
instances: authn, billing, jobs, notifications…). A layer-3 CONSUMER
could not choose or key their OWN payment/delivery/email — only the
gateway had been retrofitted for per-project config (via secrets). This
generalizes that: a project DECLARES which driver runs each capability,
and its KEYS live in the project's secrets. Same drivers, project-scoped
config, no new infra.

## 1. Declaration

`project.cms.json` → `site.services` (the consumer's one config doc):

```json
{
  "site": {
    "services": {
      "payment":  { "provider": "stripe" },
      "delivery": { "provider": "download" },
      "email":    { "provider": "resend", "from": "Shop <shop@you.com>" }
    }
  }
}
```

Providers per capability (v1): payment `stripe`; delivery `download`
(courier/parcel drivers are platform-owner additions, delivery.md);
email `cloudflare` (the alias/own-domain tiers of §3a), `resend` (BYOK); `local` = the operator default; `ses`/`twilio` PLANNED.
Absent/`local` → the operator's global service (back-compat).

## 2. Keys (secrets.md)

Each provider's secret names, set in `secrets.cms.json` → resolved from
`.platform-creds.json` at push, write-only on the server:

| capability | provider | secret names |
| ---------- | -------- | ------------ |
| payment    | stripe   | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`? |
| email      | resend   | `RESEND_API_KEY` |

## 3. Resolution (executor)

Per project, at USE time, key from the project's secrets:

- **payment** — `projectGateway(p)` builds Stripe from the project's
  `STRIPE_*` (already live; embedded checkout uses it, operator global
  as fallback).
- **delivery** — `projectDelivery(p)` builds the download driver scoped
  to the project (claim paths carry the project).
- **email** — notifications is now MULTI-TENANT: `notify` stamps the
  message `scope = projects/{p}`; the deliver handler (which runs long
  after, via the jobs queue) resolves that scope to the project's
  provider + `RESEND_API_KEY` at delivery time (`resolveScope`). An
  undeclared/unkeyed project falls back to the operator's instance —
  never a crash.

## 3a. Email: send with no setup, or from your own domain

The `resend` provider is BYOK — the builder opens a Resend account, verifies
a domain, and pastes a key before their password-reset mail can leave. That
is three steps of setup before the first email, which is exactly the cost
this product exists to remove.

**Cloudflare Email Service** (`email-sending` in the platform API, with a
Workers `EMAIL` binding) gives a second provider and a two-tier model:

| tier | `from` | setup for the builder | who owns reputation |
| --- | --- | --- | --- |
| **alias** (default) | `{project}@{platform sending subdomain}` | **none** | the platform |
| **custom** | any address on a `kind: email` domain the project verified (domains.md §1) | publish the provider's SPF/DKIM/DMARC records | the project |

A new project therefore sends immediately, and graduates to its own domain
when it wants its own reputation and branding. `resend` stays available for
anyone who would rather bring their own provider — a consumer *selects*, and
never implements (§4).

### 3a.1 Reputation is the real design constraint

One shared sending domain means **one abusive tenant degrades deliverability
for every tenant on it**. Password resets stop arriving for customers who did
nothing wrong, silently — no error, just mail in spam. So the sending
identity is designed around reputation first.

**Never send from the brand domain.** Platform-alias mail MUST leave from a
domain registered solely for sending, never from the domain that serves the
API, the marketing site, and the operator's own correspondence. A
deliverability incident then cannot touch the brand, and — because the limit
in §3a.2 is per zone — a dedicated sending zone also gets its own headroom.

**Pools, not a domain.** The alias tier is a small set of sending domains,
and a project is assigned to one by trust tier rather than round-robin.
This is the IP-pool practice of every established ESP, applied to domains
because the provider's IPs are shared. Registered domains cost roughly a
currency unit a month; the deliverability of every tenant does not.

> **Free domains are not an option, and the instinct to reach for them leads
> somewhere worse.** Free TLDs are abused heavily enough to be blocklisted
> wholesale, so mail from them starts below neutral rather than at it; free
> subdomain providers hand over a shared apex whose history is unknown and
> uncontrolled; and provider-owned hostnames (`*.workers.dev`, `*.pages.dev`)
> cannot host SPF/DKIM/DMARC at all, because publishing records requires
> controlling the zone. The goal is reputation ISOLATION, and a free domain
> supplies the opposite: pre-existing bad reputation with no control over it.

### 3a.1b Graduated sending — earn the right to email strangers

The provider bills nothing for mail to **verified destination addresses** in
the account, which makes a three-step ladder both free and abuse-resistant:

| tier | may email | requires |
| --- | --- | --- |
| **0 — self** | only the project owner's verified address | nothing |
| **1 — pool** | anyone, from a shared sending domain | a trust signal (payment, age, or an operator grant) plus quotas |
| **2 — own** | anyone, from the project's own `kind: email` domain | DNS the project publishes (domains.md §1) |

Tier 0 is the important one: a project created to send spam never reaches a
stranger's inbox, because it cannot address one. That is a stronger and
cheaper control than any content filter, and it costs a new legitimate
builder nothing — password resets and order receipts to themselves work
immediately while they are still building.

Tier 1 is a **revocable privilege**. A project that trips complaint
thresholds drops to tier 0 and keeps its tier-2 path: it loses the right to
ride shared reputation, never the ability to send.

Tier 2 is isolated by construction — DMARC aligns to the `From:` domain, so
a project on its own domain cannot affect anyone else's reputation. That is
the argument for making tier 2 easy rather than charging for it.

### 3a.1c Inbound — receiving is a different mechanism, not the reverse

Sending and receiving share a domain and nothing else: different records
(MX, not SPF/DKIM/DMARC), a different product, and a different failure mode.
So `kind: email` carries BOTH record sets and reaches `ACTIVE` on whichever
the project asked for.

| what | records | free fallback |
| --- | --- | --- |
| send | SPF, DKIM, DMARC | shared pool domain, local-part identity (§3a.1) |
| receive | MX + the provider's routing rules | `{project}@{pool-domain}` forwarded to the owner's verified address |

Two constraints that decide the shape, and neither is optional:

1. **Inbound needs the zone, not just the records.** The provider's Email
   Routing requires the domain to be a zone in a Cloudflare account — a
   customer who only publishes MX records at their existing DNS host cannot
   use it. That is strictly stronger than the sending requirement (any DNS
   host will do), so a project MAY be tier-2 for sending and fallback for
   receiving. The two are tracked independently.
2. **The 30-domains-per-zone limit is COMBINED** across Routing and Sending
   (§3a.2), so inbound on the platform zone is subject to the same ceiling
   and the same answer: a small fixed set of pool domains, identity in the
   local-part.

**Why receive at all.** Inbound routes to a Worker, which makes a received
message an ordinary platform event — `support@` becomes a `submissions` row
that the existing intake job already announces and autoresponds to
(forms.md), with no new surface. Reply-threading on an order is the same
mechanism. Absent that, a project's only inbound address is a personal
mailbox nothing can act on.

**Refuse, do not silently drop.** An address that resolves to no rule MUST
be rejected at SMTP so the sender sees a bounce. Accepting-and-discarding is
worse than not offering inbound, because the sender believes they were heard.

### 3a.2 Constraints on record (measured, not assumed)

- **Beta, Workers Paid.** Email Sending is in beta at time of writing; the
  provider seam (§1) is what lets this be adopted without betting the
  product on it — `resend` remains a selectable fallback.
- **30 domains per zone**, combined across Email Routing and Email Sending.
  This is the load-bearing constraint: **a sending subdomain per customer
  under the platform's own zone does not scale**, so the alias tier uses a
  small fixed set of platform subdomains and per-project identity lives in
  the local-part, not the domain. A project that needs domain-level
  isolation uses the custom tier, whose records land in ITS zone and so face
  the limit only against its own.
- Per message: **50 recipients** combined across to/cc/bcc, **5 MiB** total
  size, **998-character** subject, 16 KB of custom headers.
- New accounts start on conservative quotas that scale with observed
  deliverability, so the alias tier's headroom grows rather than starting
  large.

## 4. Non-goals v1

- New payment/delivery/email PROVIDERS (driver additions are the
  platform owner's, by design — a consumer selects, never implements).
- Per-service quotas/metering (quotas.md).
- Resolving the buyer's email for order mail (commerce carries
  `customer_email` when known; otherwise a configured fallback).
