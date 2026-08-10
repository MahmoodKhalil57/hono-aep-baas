# interface.md — studios and admins are one engine

Status: v1 (2026-08-10). Depends: collections.md, site.md, the nested
project addressing (auth-pools.md §3a), hono-aep-studio / hono-aep-ui.

## 0. The claim

A **studio** and an **admin** are the same thing: one renderer
(`hono-aep-studio`) showing a configured view over a project's contract
at a route. The only variable is **which plane** it edits and **who
declared the interface**:

- **studio** = the view configured to edit the **definition plane** —
  collections, themes, pages, forms (the meta-resources that shape a
  project).
- **admin** = the same view over the **data plane** — the project's JIT
  collections' rows (products, orders), driven by `site.admin`.

One engine, one source. The differences are all config + route.

## 1. Routes (all on the executor's domain)

Because projects NEST (`/v1/projects/{parent}/projects/{child}/**`),
interfaces nest with them — the nested-route rewrite gives it for free:

| route | plane | is also |
| ----- | ----- | ------- |
| `/v1/projects/{p}/studio` | definitions of p | — |
| `/v1/projects/{p}/admin`  | data of p | — |
| `/v1/projects/bastarter/projects/saastarter3/studio` | definitions of saastarter3 | **bastarter's admin over its child** |
| `/v1/projects/bastarter/projects/saastarter3/admin`  | saastarter3's store data | — |

So studio==admin and the nesting expresses "who defines the interface":
a parent's admin over a child *is* that child's studio. A reseller
(bastarter) can offer its customers a studio simply because the child's
routes exist under it — no per-reseller interface plumbing.

## 2. The engine + mode

The worker serves ONE built bundle (`dist/studio-assets`) at the routes
above; the app reads `{project, mode}` from `location.pathname`
(`…/projects/{p}/(studio|admin)`) and:

- **studio mode** → the definition-plane tabs (collections with the
  visual builder + AEP lint, themes, pages, forms, keys, secrets,
  services).
- **admin mode** → `AutoTable`/`AutoForm` (hono-aep-ui) over the
  collections named by `site.admin` — generated from the project's own
  `openapi.json` `x-aep-ui`, exactly the shape the no-build renderer
  produces, but in the one React engine.

Auth is bearer-first (cross-origin static consumers link in): the sk_
owner key or a session, stored per interface.

## 3. Config (JSON-schema'd, like everything)

The interface is declared in the project doc:

- `site.admin` (existing) — which collections/tabs the DATA interface
  shows (+ commerce panes).
- `site.studio` (optional) — override the definition tabs a consumer
  sees (default: all).

Both carry hosted `$schema`s. A parent MAY set a child's `site.admin`
(it owns the child), which is how bastarter defines saastarter3's admin
— point 4 of the vision, with no new mechanism.

## 4. The no-build fallback (kept)

Consumers who want to SELF-HOST their admin (no dependency on the
hosted engine) keep `hono-aep-bootstrap-ui`: the dependency-free
renderer that produces the same admin from `openapi.json` as static
HTML. `/site/admin.html` continues to serve it. So there are two
renderers by DEPLOYMENT need — one hosted React engine (canonical,
nestable, both planes) and one vendored no-build fallback (static
self-host, data plane) — but ONE contract underneath.

## 5. Non-goals v1

- Retiring `bootstrap-ui` (kept as the self-host fallback, §4).
- A visual editor for the interface config itself (edit `site.admin`
  in the studio like any project-doc field).
