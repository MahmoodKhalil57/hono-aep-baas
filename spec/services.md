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

### 3a.1 The shared-alias risk, and why it is bounded

One shared sending domain means **one abusive tenant degrades deliverability
for every tenant on it** — the classic failure of shared sending. Three
things bound it, and they must all hold before the alias tier is enabled:

1. **Quotas are the gate, not an afterthought** (quotas.md). Alias-tier
   sending is rate-limited per project and metered per message
   (pricing.md), so volume abuse costs the abuser first.
2. **Alias sending is a privilege, not a right.** A project that trips
   complaint thresholds loses the alias tier and keeps its own-domain path —
   its mail stops riding shared reputation, not its ability to send.
3. **Own-domain sending is isolated by construction.** A project sending
   from its own verified domain cannot affect anyone else's reputation,
   which is the argument for making that path easy rather than premium.

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
