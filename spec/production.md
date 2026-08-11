# production.md — the production-ready checklist

Status: v1 draft (2026-08-11). Depends: commerce.md, gateway.md, secrets.md,
site.md, domains.md, keys.md, quotas.md, seed.md, sync.md.

## 0. What "production-ready" means here

Not "the site deploys". The bar is:

> **A stranger can find the site, pay with a real card, receive what they
> paid for, and get help when it breaks — and the operator can prove it,
> recover from it, and get paid.**

Everything below serves that sentence. An item is `READY` only if it works
without the platform operator intervening — the whole point of self-serve.

Legend: **✅ gated** (automated, a check fails if broken) · **◐ manual**
(possible, but nobody is stopping you shipping without it) · **✗ missing**.

## 1. The two paths, side by side

| step | Odoo | here |
| --- | --- | --- |
| sign up | odoo.com account, pick apps | studio → sign up → New project |
| get credentials | — (hosted session) | mint `sk_` key → `.owner-creds.json` |
| declare the backend | click through app config | `hono-aep-baas-config/` in git → `./cli.sh sync push` |
| load data | import wizard / manual | `hono-aep-baas-idempotent-seed/` → `./cli.sh seed push` |
| third-party keys | settings screens | `.platform-creds.json` → `./cli.sh secrets push` |
| storefront | Website Builder (hosted) | `docs/` → `git push` → Pages |
| custom domain | settings + DNS | `domains/` + TXT challenge (domains.md) |
| go live | "Publish" | `git push` |

The shapes differ in one way that matters: Odoo's configuration lives in a
database behind a UI; ours lives **in git**, so the whole backend is
reviewable, diffable, and re-creatable. That is the advantage to protect —
and the reason every item below should be *declared*, not clicked.

## 2. The checklist

### A. Backend exists and is yours
- [ ] ✅ Platform account + project created
- [ ] ✅ `sk_` owner key minted, stored in gitignored `.owner-creds.json` (mode 600)
- [ ] ✅ `base` points at the surface (domains.md §6) — one field, not `endpoint`+`project`
- [ ] ◐ Key **rotation** rehearsed. `revokeApiKey()` exists but **no HTTP route
      exposes it** (keys.md gap): today revocation needs operator DB access,
      which breaks self-serve the moment a key leaks.

### B. The contract is declared
- [ ] ✅ Collections, themes, pages, forms in `hono-aep-baas-config/`
- [ ] ✅ `./cli.sh sync diff` is clean (no drift between git and the surface)
- [ ] ✅ Seed data idempotent — `./cli.sh seed push` twice ≡ once (seed.md §7)
- [ ] ✅ Every config file carries its hosted `$schema`
- [ ] ✅ `./cli.sh validate` passes

### C. Identity
- [ ] ✅ Email/password sign-up + sign-in
- [ ] ✅ Password reset delivers (needs D)
- [ ] ◐ OAuth (`GOOGLE_CLIENT_ID/SECRET`) — **callback URL must match the
      final domain**; a custom domain (domains.md §4) moves it, so this
      breaks on cutover if not re-registered
- [ ] ◐ 2FA available
- [ ] ◐ Guest → account upgrade preserves cart and orders (auth-pools onLinkAccount)

### D. Email actually delivers
- [ ] ◐ Email provider chosen (services.md §3a). The **alias tier** needs no
      setup at all and is the default; `resend` (BYOK) needs
      `RESEND_API_KEY` plus a domain verified with Resend.
- [ ] ◐ If sending from your OWN domain: a `kind: email` domain `ACTIVE`
      (domains.md §1) with the provider's SPF/DKIM/DMARC published.
      Unverified senders land in spam, which silently breaks password reset
      AND order receipts — and does so without erroring.
- [ ] ◐ Order confirmation and receipt templates reviewed
- [ ] ✗ Deliverability monitoring (bounces/complaints) — no report card yet

### E. Money — **the blocking section**
- [ ] ◐ `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` in project secrets
- [x] ✅ **`STRIPE_WEBHOOK_SECRET` is honoured per project.** The route
      verifies FIRST and dispatches second, trying each secret that may
      legitimately sign on this path — the project's own Stripe, the
      operator's gateway, then operator billing — and returns 401 if none
      verified. A merchant using their own keys now completes orders
      automatically. Two hardenings came with it: a merchant-verified event
      acts only on **that** project regardless of what its metadata claims
      (a merchant could otherwise name someone else's project), and an
      unverified payload can no longer 202 by falling through to a
      `local` billing instance, which returns `{ignored:true}` WITHOUT
      verifying.
- [ ] ◐ Live keys (not test) and a real end-to-end purchase performed
- [ ] ◐ Refund path exercised from the admin
- [ ] ✗ Tax / VAT — no tax engine (parity.md §2.5). Fine for digital goods in
      one jurisdiction; not fine for EU B2C at scale
- [ ] ✗ Invoice numbering (parity.md §2.4 sequences) — legal requirement in
      many jurisdictions

### F. Fulfilment
- [ ] ◐ `services.delivery.provider` declared (download for digital)
- [ ] ◐ Delivery artifact reachable by the buyer, with an expiring token
- [ ] ◐ Order lifecycle end-to-end: cart → paid → fulfilled → delivered

### G. The operator can operate
- [ ] ✅ Admin renders from the contract (`{BASE}/admin`)
- [ ] ✅ Studio edits definitions (`{BASE}/studio`)
- [ ] ◐ Someone other than the developer can find and use it
- [ ] ✗ Roles beyond owner — no per-user permissions inside a project
      (Odoo ships access groups; we have one owner + pool end-users)

### H. Domain and transport
- [ ] ◐ Custom domain declared and **ACTIVE** (domains.md — a `PENDING`
      host does not route)
- [ ] ◐ Frontend domain CNAME + `docs/CNAME` present (deleting it silently
      tears the domain down on the next push)
- [ ] ✅ TLS (Workers custom domains / Pages provision it)
- [ ] ◐ Canonical URL matches the live domain — `site.url` drives sitemap,
      robots, llms, OG; stale values mis-declare the whole site

### I. Discoverable
- [ ] ✅ `sitemap.xml`, `robots.txt`, `llms.txt` generated from `site.url`
- [ ] ✅ OG cards render
- [ ] ✅ `./cli.sh audit` / `check:links` pass
- [ ] ✅ Lighthouse budgets met (`perf`)
- [ ] ✅ PWA check passes (`check:pwa`)

### J. Trust and law
- [ ] ✗ **No terms, privacy, or returns page ships in the template.** The
      storefront has 14 pages and none of them is legal. Stripe requires
      terms and a refund policy; GDPR requires a privacy notice.
- [ ] ✗ Cookie/consent notice where required
- [ ] ✗ Data export / delete on request (GDPR) — no self-serve path
- [ ] ◐ Contact route a human answers (form exists; monitoring it is manual)

### K. Operations
- [ ] ✅ Wide events per request; `X-Request-Id` on every response
- [ ] ✅ Health probes (`/livez`, `/readyz`, `/healthz`)
- [x] ✅ **Point-in-time recovery exists and nobody knew.** D1 **Time Travel**
      is always-on, free, and restores any minute in the last 30 days, per
      database; DO SQLite has its own 30-day PITR. This was listed as a
      blocker; it is a default.
- [ ] ◐ **>30-day retention** — export D1 → R2 on a schedule (parity.md §2.7).
- [ ] ✗ **A restore has never been rehearsed.** The mechanism is free; the
      confidence is not. This is the gap, not the backup itself.
- [ ] ◐ Alerting — Cloudflare **`alerting`** (policies + destinations) is a
      binding, not a missing capability; nothing is wired to it yet
- [ ] ◐ Quotas/rate limits (quotas.md is spec-first; Rate Limiting unbound)

### L. Recovery rehearsed
- [ ] ✗ Restore actually tested (a backup nobody has restored is a hope)
- [ ] ◐ Rebuild from git proven: fresh project + `sync push` + `seed push`
      reproduces the store. This one is genuinely strong — the config IS the
      backup for everything except customer-generated rows.

## 3. Blockers — fix before any real store

Ordered by what breaks first:

1. ~~Per-project Stripe webhook verification~~ — **FIXED** (§E).
2. **A `keys:revoke` route** (§A). A leaked key is unrecoverable self-serve.
3. **Legal pages in the template** (§J). Cheap to add, and Stripe will ask.
4. **A rehearsed restore** (§K, §L). Time Travel already covers the mechanism;
   what is missing is evidence that a restore works and that someone has done
   one. Customer rows are the only thing git does not already hold.

## 4. What Odoo has that we deliberately will not

- **Access groups / granular roles** — real gap (§G), worth doing.
- **Chart of accounts, taxes, fiscal positions** — platform capability, not
  a document (parity.md §2.5); deliberately later.
- **Module install/upgrade machinery** — capabilities are bound, not
  installed (kinds.md §4).
- **Staging environments** — git branches plus a second project already give
  this; document the ritual rather than build a feature.

## 5. Conformance

A template claiming production-readiness MUST pass §B, §I, and §K's gated
rows in CI, and MUST document any `◐`/`✗` it ships with — as saastarter2
already does under "Known limits". Silence about §E would be the dishonest
failure mode this document exists to prevent.
