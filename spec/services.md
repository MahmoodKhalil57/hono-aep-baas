# services.md — per-project service selection

Status: v1 (2026-08-10). Depends: secrets.md, commerce.md, gateway.md,
delivery.md, notifications (suite kind), sync.md §6.

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
"site": {
  "services": {
    "payment":  { "provider": "stripe" },
    "delivery": { "provider": "download" },
    "email":    { "provider": "resend", "from": "Shop <shop@you.com>" }
  }
}
```

Providers per capability (v1): payment `stripe`; delivery `download`
(courier/parcel drivers are platform-owner additions, delivery.md);
email `resend` (`local` = the operator default; `ses`/`twilio` PLANNED).
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

## 4. Non-goals v1

- New payment/delivery/email PROVIDERS (driver additions are the
  platform owner's, by design — a consumer selects, never implements).
- Per-service quotas/metering (quotas.md).
- Resolving the buyer's email for order mail (commerce carries
  `customer_email` when known; otherwise a configured fallback).
