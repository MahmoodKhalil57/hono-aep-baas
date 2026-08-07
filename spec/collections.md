# Hosted Collections

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/collections`
**Status:** draft

## Abstract

The flagship feature the saastarter port demands: per-project,
user-declared resources — blogs, products, reviews, wishlists — served
by the baas. The load-bearing realization: this is NOT a new engine.
"Collections with typed fields, row-filter access, and lifecycle hooks"
is exactly the suite's existing resource model (dialect → defineResource
→ policies → events), so hosted collections = **the developer meta-API
as a product**, multi-tenant. The port's job is to force the missing
field/policy branches into existence, not to reinvent Payload.

## 1. Declaration

`hono-aep-baas-config/collections/<slug>.cms.json` declares a resource
in the DIALECT's document form (the same shape the suite's meta-API
already round-trips); sync applies it like any other document
(sync.md), and the account serves it at
`/v1/projects/{p}/collections/{slug}/rows/…` — standard AEP methods,
generated admin, generated MCP tools, generated OpenAPI. The dashboard
and MCP can author collections too (three surfaces, one write surface).

## 2. Field-type requirements (mapped to the suite)

What saastarter's 23 collections actually use, and where each stands:

| field capability | suite status |
|---|---|
| scalars, enums, arrays/objects (JSON) | EXISTS (dialect schema) |
| references (single + hasMany) with FK integrity | EXISTS (reference/parent) — hasMany TODO(saastarter) |
| unique + indexed fields | partial — declarative `unique`/`index` knobs TODO(saastarter) |
| draft/published `_status` | EXISTS (states + transitions) |
| soft delete | EXISTS (AEP-164) |
| localized fields with fallback | spec-first (cms localization.md) — TODO(saastarter) |
| rich text (portable JSON) | markdown-first per suite §3a; a lexical-compatible JSON column is an open question, recorded not decided |
| uploads with image derivatives | media kind (implemented) — per-project buckets + variants TODO(saastarter) |
| select labels per locale | rides localization when it lands |

## 3. Access model

Row-filter access (`{customer: {equals: user.id}}`) is our owner/grants
policy family: `owner(field)` covers the ownership filters saastarter
uses everywhere, role arrays are `role(...)`, and the PLANNED `grant`
predicate covers explicit sharing. Named reusable policies (their
`isDocumentOwner`, `adminOrPublishedStatus`) become dialect-level policy
aliases — TODO(saastarter). One deliberate hardening: saastarter ships
world-readable PII (contact submissions, the mailing list) and
world-writable blogs because open access is its DEFAULT; ours is
fail-closed — the port gets safe access rules by construction.

## 4. Logic: bindings, not hosted code (the boundary, restated)

~30 of saastarter's endpoints are bespoke (money math, joins,
idempotent third-party calls). Hosting user code remains a NON-GOAL
(README §1). The port's architecture answers this honestly:

- **Declarative reach**: transitions + event bindings + jobs +
  notifications cover the hook chains (order emails, low-stock alerts,
  counter bumps) — saastarter's own hooks are fire-and-forget event
  handlers, which is exactly our events → jobs shape.
- **The bespoke remainder lives app-side**: the react-router frontend
  is a framework-mode app whose server loaders/actions ARE the escape
  hatch — they call the baas with an `sk_` key, do their money math,
  and stay in the consumer's repo. The baas hosts state, auth, delivery,
  and contracts; the app hosts its own irreducible logic. No sandboxed
  functions product required.

## 5. Generated surfaces

Each project's collections project into: the dashboard's admin CRUD
(the suite's generated admin), the per-project MCP endpoint
(agents.md §3), and a per-project OpenAPI document with a PUBLIC /
PRIVATE split — public spec lists only publicly-readable operations
with security stripped; the full spec sits behind the owner's key.
Docs split: TODO(saastarter).

## 6. References

- suite: cms dialect + meta-API, localization.md, media, AEP-164/216
- baas: README §1 (non-goals), sync.md, agents.md, auth-pools.md
- survey: saastarter (Payload collections + ecommerce plugin)
