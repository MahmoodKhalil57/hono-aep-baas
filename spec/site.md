# Hosted Site Documents

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/site`
**Status:** draft

## Abstract

The suite's CMS layers — tweakcn themes, Puck pages AND standalone
Puck blocks, the PWA + SEO/AEO surface, the generated admin — are all
DOCUMENTS plus contract-driven React components. Neither half needs inventing for hosted mode: the
baas hosts the documents per project (JIT, three surfaces, synced), and
the consumer's STATIC react-router SPA renders them with the existing
packages (hono-aep-blocks CmsPage, hono-aep-ui admin, the base
component contract). The baas never hosts the frontend; it hosts what
the frontend reads.

## 1. The document set (per project)

The suite's exact document types, project-scoped:

| document | edited by | consumed as |
|---|---|---|
| `themes/<name>.cms.css` | tweakcn visual editor in the dashboard studio; git sync; MCP | `<link rel="stylesheet" href="{endpoint}/projects/{p}/theme.css">` — one tag restyles the whole SPA through the base component contract |
| `pages/<slug>.cms.json` (Puck) — SERVING IMPLEMENTED | the Puck builder in the dashboard; sync; MCP | `CmsPage` (hono-aep-blocks) renders the JSON client-side — public read, owner write, Puck-shape guarded; the flagship's catch-all route mounts it |
| `blocks/<slug>.cms.json` (Puck fragments) — SERVING + `CmsBlock` IMPLEMENTED | the same Puck builder, fragment-scoped | a SECTION, not a page — fetched by URL and rendered AS-IS (`<CmsBlock url=…>`, shipped in hono-aep-blocks) inside the consumer's OWN code routes |
| `site.cms.json` | dashboard form; sync; MCP | name/locale/urls/OG defaults — the head/SEO context |

Round-trip law applies unchanged; sync (sync.md) gains the `.cms.css`
document type — TODO(saastarter). saastarter's 10 color schemes + dark
mode port AS tweakcn theme documents; its marketing pages MAY port as
Puck pages (the "if the user wants a cms for some pages" tier — pages
are optional; a consumer can ship pure code routes and use none of
this).

## 2. PWA + SEO/AEO for a static SPA — reification IMPLEMENTED
(`sync artifacts --out <public> --base /repo`: manifest.webmanifest
(buildManifest over site config + theme tokens, base-path'd id/
start_url/scope), sitemap.xml, robots.txt, llms.txt. Remaining: the
service worker, per-page .md mirrors, icon generation, prerender.)

A static SPA can't server-render its head or serve dynamic app
artifacts — the suite's answer splits in two, both from the declared
content:

1. **Build-time reification**: `sync pull` (or the SPA's build step)
   writes the artifacts INTO the static site's public/ —
   - discovery: sitemap.xml, robots.txt (+ Content Signals),
     llms.txt / llms-full, per-page `.md` mirrors, JSON-LD fragments,
     OG defaults;
   - **PWA**: manifest (from `site.app` + the theme's tokens — the
     suite's generator, with the Pages base path feeding `start_url`
     and scope), icons, and the service worker (offline shell +
     precache; the suite's no-clients.claim + deferred-registration
     discipline applies) — an INSTALLABLE app off a static host;
   generated from site.cms.json + pages + collections exactly as the
   suite does today, but as pull outputs instead of runtime routes.
   Rebuild on content change (CI: `sync diff --exit-code` already
   fails the build when content moved), and the check:pwa audit runs
   against the built output in the same CI.
2. **Prerender**: react-router SPA mode prerenders the page routes it
   learns from the project's pages list — crawlable HTML for hosted
   pages with zero server. The consumer opts in per route.

The baas API host keeps its own agent surface (agents.md §1) — this
section is about the CONSUMER's static origin.

## 2a. GitHub Pages, first-class (the reference host)

The flagship frontend MUST deploy to GitHub Pages unmodified — the
cheapest host with the strictest constraints, which is the point: what
works on Pages works anywhere static, and its constraints ENFORCE the
frontend-only rule (there is no server to sneak logic into).

1. **Base path**: project pages serve under `/{repo}/` — the app takes
   its basename from config (react-router `basename` + build `base`);
   `/` and `/{repo}/` both work.
2. **Deep links**: Pages has no rewrites — the build emits `404.html`
   (the SPA shell) so refreshes on client routes recover, and hosted
   page routes are PRERENDERED (§2) so crawlers never depend on the
   fallback.
3. **`.nojekyll`** ships in the build output (Jekyll eats underscore-
   prefixed asset paths).
4. **Cross-origin API contract** (the baas side, NORMATIVE): the API
   serves wildcard `*` CORS on /v1 and /submit — WITHOUT
   `Allow-Credentials`. Consequence, by design: public reads and
   Bearer-key flows work from any static origin, while session COOKIES
   stay same-origin (the dashboard). Static origins authenticate with
   tokens, never cookies: pk_ for public writes, sk_ for tooling, and
   the auth pool's BEARER sessions for end users —
   TODO(saastarter) at auth-pools.md (better-auth bearer transport).
   ETag/If-Match are exposed/allowed headers (sync and optimistic UI
   need them).
5. **CI shape**: `sync diff --exit-code` → `sync pull` (SEO artifacts +
   keys) → build → `actions/deploy-pages`. The backend deploys with
   `sync push`; the frontend is just files.

## 3. The automatic admin panel

The generated admin is contract-driven React (hono-aep-ui) — it needs
only `openapi.json` + a session/key. Two mountings, no new machinery:

1. **The dashboard** hosts it for every project (the owner surface).
2. **The consumer's SPA** MAY mount the same components at `/admin`
   behind the project's auth pool — a white-label admin inside the
   static app, restyled by the project's own theme through the base
   contract.

## 4. Phasing

Themes first (smallest document, biggest visible win; unblocked
today), then pages (needs collections for bound blocks), then the
SEO reification (needs pages), admin-in-SPA alongside the auth pool.
Rows carried in README §3; demand markers at the suite branches.

## 5. References

- suite: hono-aep-cms (themes/pages/site documents, studio), hono-aep-
  blocks (CmsPage + base contract), hono-aep-ui (generated admin), seo
  surface, cms/execution-modes.md
- baas: sync.md (document types), collections.md, auth-pools.md,
  agents.md; saastarter (color schemes + marketing pages as the port
  workload)
