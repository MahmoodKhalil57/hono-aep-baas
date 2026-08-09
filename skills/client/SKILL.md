---
name: hono-aep-baas-client
description: Build frontend features for a static site backed by a hosted hono-aep-baas project (auth, commerce, collections, i18n, themes, forms, generated admin) using only the public /v1 contract — and escalate platform-level gaps as GitHub issues to MahmoodKhalil57/hono-aep-baas. Use when working in a baas consumer repo (it has hono-aep-baas-config/, hono-aep-baas-idempotent-seed/, cli.sh, or a js/config.js pointing at /v1/projects/{id}).
---

# hono-aep-baas client development

You are working in a CONSUMER of a hosted hono-aep-baas: a static site
(GitHub Pages class — no server in this repo, no build step) whose whole
backend is a project on the platform. Everything you need is behind one
public, self-describing API.

## Orient (do this first)

1. Coordinates: read `js/config.js` (frontend) or
   `hono-aep-baas-config/baas.json` — `endpoint` + `project` give
   `BASE = {endpoint}/v1/projects/{project}`.
2. The contract is discoverable, never guessed:
   - `GET {BASE}/openapi.json` — every collection, field, policy and
     `x-aep-ui` metadata (labels, widgets, localized flags).
   - `{endpoint}/v1/schemas/{kind}.json` — JSON Schemas for every
     config/seed file kind; every repo JSON declares its `$schema`.
   - `{BASE}/mcp` — the project MCP server, same contract for agents.
3. Maintenance loop: `./cli.sh` (or `bunx hono-aep-baas-cli`) —
   `sync|seed|secrets|validate`, keys from `.owner-creds.json`, secret
   values from `platform-creds.json` (both gitignored, repo root).

## Golden rules (violating these breaks real users)

- **One write surface.** Website, admin, CLI, MCP, agents — all speak
  the same public `/v1`. Never invent a side channel.
- **Static-first.** Nothing in this repo executes on a server. If a
  feature needs server-side logic, it belongs to the PLATFORM — see
  Escalation below before writing a workaround.
- **Bearer-first auth.** The API returns the session in the
  `set-auth-token` response header (cookies are useless cross-origin);
  send it back as `Authorization: Bearer`. OAuth MUST start as a
  top-level navigation to
  `{BASE}/auth/sign-in/social/{provider}?callbackURL=…` (a fetch drops
  the state cookie → state_mismatch); the session returns in the URL
  fragment `#auth_token`. 2FA bridges via `set-two-factor-token` /
  `two-factor-token` headers.
- **Guest by default.** Never gate the cart behind sign-in:
  `ensureSession()` mints an anonymous session on first need; the
  platform re-parents carts/orders/wishlists on account upgrade.
- **The cart converts on PAID, not on checkout click.** Checkout is an
  attempt; keep the cart until the order pays.
- **Locale discipline.** Read with `?locale={tag}` (flat values, fallback
  chain), author with `?locale=all` (locale maps), write one locale via
  `PATCH …?locale={tag}` (the server merges the map). Localized fields
  are `{en: …, ar: …}` maps on the wire.
- **Contract-driven UI beats hand-written UI.** Tables/forms should be
  generated from `openapi.json`'s `x-aep-ui` (see the admin pattern in
  references/client-recipes.md) so new collections appear without code.

## Recipes

`references/client-recipes.md` has request-level detail for: rows CRUD
+ filters + `:search`, auth (email/password, OAuth, 2FA, anonymous),
commerce (cart → checkout hosted/embedded → orders → fulfillment,
discounts), forms (`/submit/{key}` from static HTML), media upload,
theming (one `theme.css` link + tweakcn token vocabulary), hosted site
assets (`{BASE}/site/…`: generated admin.html, manifest, sitemap,
llms.txt, sw.js, favicon, OG cards), and the generated-admin renderer.

## Escalation: client-doable vs platform-needed

**Never file an issue for** (all self-serve, do it in-repo):
- New/changed collections, fields, policies, states → edit
  `hono-aep-baas-config/collections/*.cms.json`, `./cli.sh sync push`.
- Content, products, discounts, demo users → seed files, `./cli.sh seed push`.
- Theme/pages/forms/admin composition/SEO/OG config → config repo
  (`project.cms.json` site.*), sync push.
- Your own Google OAuth or Stripe keys → `platform-creds.json` +
  `secrets.cms.json`, `./cli.sh secrets` (per-project secrets store).
- Anything expressible as frontend JS/HTML over the endpoints above.

**File a GitHub issue to `MahmoodKhalil57/hono-aep-baas` when** the need
is genuinely server-side and not in the contract:
- A new payment or delivery gateway driver (Omnipay-style: drivers are
  platform-owner additions by design).
- Per-project inbound webhook verification, email/notification
  providers, image derivatives, scheduled behaviors — anything that
  must EXECUTE on the platform.
- A `/v1` response that contradicts its spec/openapi (bug), or a
  missing conformance behavior.

Procedure (use `gh`):
1. Search first: `gh issue list -R MahmoodKhalil57/hono-aep-baas --search "<terms>" --state all`.
2. File with the structure in `references/issue-templates.md`:
   bugs carry endpoint + method + `X-Request-Id` (every /v1 response
   returns one — it indexes the platform's wide-event log) + expected vs
   actual; feature requests carry the use-case, the proposed PUBLIC
   contract shape (new route/field/driver — never a backdoor), and why
   no static workaround exists.
3. Never put secrets, sk_ keys, or customer PII in an issue; project id
   and request ids are fine.
