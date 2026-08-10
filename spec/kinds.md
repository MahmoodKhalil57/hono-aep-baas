# kinds.md — a CMS that builds a CMS

Status: v1 draft (2026-08-11). Depends: collections.md (the data plane),
surface.md (BASE + the two planes), interface.md (studio == admin),
auth-pools.md §3a (nested projects), keys.md, quotas.md.

## 0. The claim

hono-aep-baas is built on hono-aep: the framework supplies `defineResource`,
and the platform *invents* `project`, `collection`, `theme`, `page`, `form`,
`domain` on top of it. That is a layering — and today it happens exactly
once, in TypeScript, at build time.

The same layering must be available at RUNTIME, as data, to every project:

| layering | who declares it | when | recursive today |
| --- | --- | --- | --- |
| packages (`suite.json`) | an engineer, in code | build time | once, by hand |
| **projects (`kinds/`)** | **a builder, in the CMS** | **runtime** | **unbounded** |

They are the same recursion; one is compiled and one is data-driven. When
both exist, a CMS can build a CMS that builds a CMS, and hono-aep-baas
becomes the core engine of an ecosystem rather than a single product.

This spec defines the runtime half.

## 1. Shape is free; capability is inherited

The load-bearing distinction, and the honest bound on what "fully
data-driven" can mean.

Applying a collection document already produces a **shape** —
`resourceFromDocument` returns a resource blueprint (fields, states,
transitions, policies). What makes that shape *live* is **behavior** the
platform supplies: JIT dispatch, tenancy-scoped storage, policy enforcement,
generated OpenAPI/MCP/studio.

So:

> **A layer may invent any SHAPE it likes. Every shape must BIND to a
> capability its parent already holds.**

- **Shapes are free.** bastarter may invent `models`, `spaces`, `widgets`,
  `blueprints` — names and fields hono-aep-baas never conceived.
- **Capabilities are inherited and may only narrow.** `bind` names the
  platform behavior powering the shape. A layer cannot conjure a behavior
  it was not granted.

This is precisely how hono-aep-baas relates to hono-aep: it invented
`collection` (a shape) bound to `defineResource` (a capability). It could
not have invented "send email" without a mail capability underneath.

**What this does NOT give you.** A layer cannot invent new *semantics*.
Declaring `deployments` bound to `collection` yields collection semantics
under a new name — rows, not deploys. New behavior is a platform change
(a new capability in §6), not a document. A spec that implied otherwise
would be promising magic.

## 2. `kinds/` — declaring your children's platform

Perfect symmetry with the data plane, which is what makes this teachable:

| directory | declares | for |
| --- | --- | --- |
| `collections/*.cms.json` | data resources | **my own app** |
| `kinds/*.cms.json` | meta-resources | **my children's platform** |

Same file shape, one level up. A `kind` document:

| field | meaning |
| --- | --- |
| `singular`, `plural` | the names a child sees (`model` / `models`) |
| `bind` | REQUIRED. The inherited capability powering it (§6) |
| `fields` | the shape, exactly as a collection document declares it |
| `states`, `transitions` | optional lifecycle, as in any resource |
| `policy_*` | who may call each method, in the existing vocabulary |
| `constrain` | optional narrowing of the bound capability (§4) |
| `defaults` | optional values pinned on every document of this kind |

Declaring a kind is the whole projection: **a child's platform is exactly
the kinds its parent declared.** There is no separate grant list to keep in
sync, and no "white-label" flag — the documents ARE the product definition.

## 2a. Config size tracks how much platform you are building

A useful sanity check, and today it is **inverted** — which is the clearest
evidence the primitive is missing:

| repo | builds | config today | config it SHOULD carry |
| --- | --- | --- | --- |
| saastarter2 | one store (an app) | 5 collections, 2 forms, theme, secrets | about the same |
| saastarter3 | one store (an app) | same | about the same |
| bastarter | **a CMS** | **one theme** | **strictly the largest** |

An ecommerce site declares ITS OWN data. A platform declares its own data
**and its children's entire platform**, so its config is a superset in kind,
not just in size:

```
bastarter/hono-aep-baas-config/
  project.cms.json          # the console itself
  themes/*.cms.css
  collections/*.cms.json    # bastarter's OWN app: customers, plans, usage
  kinds/                    # ← the part that makes it a CMS
    models.cms.json         #   bind: collection  (renamed, constrained)
    themes.cms.json         #   bind: theme
    projects.cms.json       #   bind: project     (its customers are platforms too)
    …one file per capability bastarter resells
  secrets.cms.json
```

> **Invariant.** A project that grants `project` (§6) carries strictly more
> config than one that does not: it declares an app AND a platform. If
> building a CMS is not visibly more work than building a store, the
> platform is being handed over as an opaque flag rather than defined — the
> exact failure this spec removes.

The corollary matters for teaching: nothing about saastarter2 gets heavier.
A store builder never writes a `kinds/` file (§5), so the cost lands only on
whoever is actually building a platform.

## 3. The narrowing law

Let `holds(P)` be the capabilities a project may bind.

```
holds(root)  = the full catalog (§6)
holds(child) = { bind(k) : k ∈ kinds(parent(child)) }
```

A kind declared by `P` MUST bind to a capability in `holds(P)`; anything
else is rejected at the apply gate.

Three consequences, and they are the reason this recurses safely:

1. **Narrowing only.** Each layer can rename, redact, and constrain, never
   widen. A layer physically cannot hand a customer something it was not
   handed. Safety is structural, not policed.
2. **Composition is associative.** A depth-N surface is the fold of N
   projections; there is no depth-specific code, exactly as the BASE prefix
   law gives nesting for free (surface.md §1).
3. **Attenuation is monotone.** Capability sets shrink down the chain, so
   the chain terminates: eventually a layer holds nothing and can declare
   no kinds. Infinite *depth* is permitted; infinite *authority* is not.

## 4. What a kind may do to the capability it binds

- **Rename.** `collection` → `models`. Names are the layer's own; nothing
  downstream sees the parent's vocabulary.
- **Redact.** Declare fewer kinds than you hold. A capability with no kind
  is invisible and unreachable to children.
- **Constrain.** `constrain` narrows the bound capability's own surface —
  e.g. a `models` kind that permits only `string|number|boolean` fields, or
  forbids `soft_delete`. Constraints compose by intersection.
- **Pin defaults.** `defaults` fixes values on every document of the kind
  (e.g. `policy_list: "public"`), so a layer can ship opinionated products.
- **Restrict methods.** `policy_*` per kind, in the existing vocabulary.

A kind MUST NOT be able to relax a constraint or default imposed above it;
the effective value is the intersection down the chain.

## 5. Inheritance is the default (the beginner clause)

**Absent `kinds/` ⇒ a project's children inherit its kinds unchanged.**

A builder who never opens this file gets today's behavior exactly: the
platform's own kinds, unrenamed. Nothing breaks, and the concept stays
invisible until someone deliberately wants to shape a platform. Declaring
kinds is the advanced move, never the price of entry.

## 6. The capability catalog

`bind` targets are the suite's real behaviors, not invented ones. Each is
already implemented and already backed by a Cloudflare product:

| capability | behavior | backed by |
| --- | --- | --- |
| `collection` | a document becomes a live tenant-scoped REST resource | D1 (drizzle) |
| `theme` | canonicalized CSS served per project | D1 |
| `page`, `block` | structured documents + renderer | D1 |
| `form` | public submit endpoint + minted `pk_` key | D1 |
| `domain` | verified host → surface routing (domains.md) | Workers custom domains |
| `media` | blob upload/serve | R2 |
| `search` | indexed query + embeddings | Workers AI |
| `jobs` | queued async work | Queues / cron |
| `notifications` | multi-channel delivery | provider + Queues |
| `authn` / `auth_pool` | platform and end-user identity | D1 |
| `secrets` | per-project encrypted values | D1 |
| `billing`, `gateway`, `delivery`, `connections`, `flags` | the capability-service tier | provider + D1 |
| `project` | **creating child projects** — the capability that makes a child a platform in turn | D1 |

`project` is the recursive one: granting it makes a customer a platform,
withholding it makes them a leaf. That single bind decides whether your
product is a CMS or an app.

Adding a capability is a PLATFORM change (code + spec), deliberately: it is
the boundary between "compose what exists" and "extend the engine".

## 7. Nobody above the root needs a Cloudflare account

The root owns the account and the bindings; every capability above it is
consumed through the parent's surface. A layer-3 builder creates an account
on hono-aep-baas (or on a white-label above it), gets credentials, syncs a
config, and has a backend — with no Cloudflare account, no worker, no
database, and no deploy of their own. That is the product claim this spec
exists to make true, and §3's narrowing law is what makes it safe to offer.

## 8. Metering and billing (PLANNED)

Every capability invocation crosses a known seam, so usage is attributable
per project AND per ancestor chain — the same fold as §3. That is the
natural attach point for Stripe: the root bills its layer, each layer bills
its own customers, and no layer needs the root's billing relationship.
Recorded here so the seam is designed for it, not retrofitted.

## 9. Conformance

1. A kind binding a capability outside `holds(P)` is refused at apply.
2. Absent `kinds/`, a child's platform is byte-identical to today's.
3. Renaming is total: a child sees only its layer's vocabulary — in routes,
   OpenAPI, MCP `describe`, and the studio.
4. Constraints and defaults intersect down the chain; no layer can relax an
   ancestor's.
5. A depth-3 platform (root → A → B → C) works with no depth-specific code.
6. Redaction is complete: a capability with no kind is absent from every
   projection — routes, contract, agent surface, and interface alike.
7. Granting `project` makes a child a platform; withholding it makes the
   child a leaf, and its own `kinds/` is then inert.

## 10. Non-goals v1

- **Inventing semantics.** New behavior is a new capability (§1), not a
  document.
- **Cross-layer capability lending** (a grandchild binding something its
  parent lacks, by arrangement with the root). Breaks the narrowing law and
  with it the safety argument.
- **Per-kind custom code.** Handlers/hooks stay platform-side; a kind is
  declarative, which is what keeps it beginner-friendly and safe to host.
- **Rewriting the package layering.** `suite.json` stays the build-time
  index; this spec governs the runtime one (§0).
