# Hosted Site Documents

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/site`
**Status:** draft

## Abstract

The suite's CMS layers — tweakcn themes, Puck pages, the SEO/AEO
surface, the generated admin — are all DOCUMENTS plus contract-driven
React components. Neither half needs inventing for hosted mode: the
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
| `pages/<slug>.cms.json` (Puck) | the Puck builder in the dashboard; sync; MCP | `CmsPage` (hono-aep-blocks) renders the JSON client-side — hosted CMS pages INSIDE a static site, blocks bound to the project's collections |
| `site.cms.json` | dashboard form; sync; MCP | name/locale/urls/OG defaults — the head/SEO context |

Round-trip law applies unchanged; sync (sync.md) gains the `.cms.css`
document type — TODO(saastarter). saastarter's 10 color schemes + dark
mode port AS tweakcn theme documents; its marketing pages MAY port as
Puck pages (the "if the user wants a cms for some pages" tier — pages
are optional; a consumer can ship pure code routes and use none of
this).

## 2. SEO/AEO for a static SPA

A static SPA can't server-render its head — the suite's answer splits
in two, both from the declared content:

1. **Build-time reification**: `sync pull` (or the SPA's build step)
   writes the discovery artifacts INTO the static site's public/ —
   sitemap.xml, robots.txt (+ Content Signals), llms.txt / llms-full,
   per-page `.md` mirrors, JSON-LD fragments, OG defaults — generated
   from site.cms.json + pages + collections exactly as the suite does
   today, but as pull outputs instead of runtime routes. Rebuild on
   content change (CI: `sync diff --exit-code` already fails the build
   when content moved).
2. **Prerender**: react-router SPA mode prerenders the page routes it
   learns from the project's pages list — crawlable HTML for hosted
   pages with zero server. The consumer opts in per route.

The baas API host keeps its own agent surface (agents.md §1) — this
section is about the CONSUMER's static origin.

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
