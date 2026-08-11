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

## 0. Execution mode — IMPLEMENTED

Hosted collections run the suite's **JIT execution mode**
(cms/execution-modes.md): the declared document becomes a live resource
via `resourceFromDocument`, rows live in the generic `json_rows` storage
(per-project scope = tenancy isolation), and the equivalence law
guarantees the contract is identical to a compiled app's. Promotion
(perf) and ejection (`sync pull` → `.cms.ts` in the tenant's own app)
are defined there — hosting is never lock-in.

## 1. Declaration

`hono-aep-baas-config/collections/<slug>.cms.json` declares a resource
in the DIALECT's document form (the same shape the suite's meta-API
already round-trips); sync applies it like any other document
(sync.md), and the account serves the declared resource at its OWN
plural — `/v1/projects/{p}/{plural}/…` (true AEP paths; reserved
plurals refused) — standard AEP methods,
generated admin, generated MCP tools, generated OpenAPI. The dashboard
and MCP can author collections too (three surfaces, one write surface).

## 2. Field-type requirements (mapped to the suite)

What saastarter's 23 collections actually use, and where each stands:

| field capability | suite status |
|---|---|
| scalars, enums, arrays/objects (JSON) | EXISTS (dialect schema) |
| references (single + hasMany) | EXISTS — hasMany verified through both modes (path-shape validation; FK integrity stays single-ref/parent) |
| unique + indexed fields | EXISTS — `unique`/`indexed` field knobs; the FRAMEWORK answers 409 in both modes, compiled DDL is the backstop |
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

### 3a. Fail-closed on ROWS, fail-OPEN on FIELDS (the PII gap)

The hardening above is true of the **row** axis and false of the **field**
axis, and the distinction is load-bearing enough to state plainly:

> Policies bind at the METHOD surface (`auth/authz.schema.json`). Field-level
> read policies are **PLANNED, not implemented**. So a collection with
> `policy_get: "public"` exposes **every field of the row it returns.**

A `customers` collection readable only by its owner leaks nothing; a
publicly-readable `reviews` collection carrying `author_email`, or a
`submissions` collection with an internal `notes` field, publishes that data
to anyone. Nothing today hides a field while keeping the row readable — the
AEP-157 read-mask is a caller convenience, **never an access control**.

Until field policies land, the only safe constructions are:

1. Do NOT put a field in a collection whose row policy is broader than the
   field deserves — **split the resource** (public `reviews`, owner-scoped
   `review_contacts`) rather than relying on clients to omit it.
2. Read any `policy_list`/`policy_get` of `public` as a declaration that
   **every field is public**, and review the field list on that basis.

Recorded as a spec-vs-implementation gap rather than a design choice:
`authz.schema.json` already reserves the vocabulary ("a field policy hides
the field from unauthorized reads rather than erroring"), so the fix is to
implement the reserved branch, not to invent a mechanism.

## 4. Logic: bindings, not hosted code (the boundary, restated)

~30 of saastarter's endpoints are bespoke (money math, joins,
idempotent third-party calls). Hosting user code remains a NON-GOAL
(README §1). The port's architecture answers this honestly:

- **Declarative reach**: transitions + event bindings + jobs +
  notifications cover the hook chains (order emails, low-stock alerts,
  counter bumps) — saastarter's own hooks are fire-and-forget event
  handlers, which is exactly our events → jobs shape.
- **The flagship frontend is STATIC** (react-router SPA mode +
  shadcn, beginner-friendly, no server code): everything it needs MUST
  come from the baas over HTTP — which is the forcing function keeping
  the declarative surface honest. Where a consumer truly needs bespoke
  server logic (money math, third-party orchestration), the escape
  hatch is an OPTIONAL thin server in their own repo calling the baas
  with an `sk_` key — an advanced pattern, never the default. The baas
  hosts state, auth, delivery, and contracts; no sandboxed functions
  product required.

## 5. Generated surfaces

Each project's collections project into: the dashboard's admin CRUD
(the suite's generated admin), the per-project MCP endpoint
(agents.md §3), and a per-project OpenAPI document with a PUBLIC /
PRIVATE split — public spec lists only publicly-readable operations
with security stripped; the full spec sits behind the owner's key.
Docs split: TODO(saastarter).

## 6. References

- suite: cms dialect + meta-API, cms/execution-modes.md, localization.md, media, AEP-164/216
- baas: README §1 (non-goals), sync.md, agents.md, auth-pools.md
- survey: saastarter (Payload collections + ecommerce plugin)
