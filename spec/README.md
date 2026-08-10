# hono-aep-baas (`mizan-gpp`)

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/product`
**Status:** draft

## Abstract

A backend-as-a-service that dogfoods the hono-aep suite: hosted,
AIP-compliant backend primitives consumable from static HTML, forms
first. The founding observation (web3forms): an HTML-and-CSS-only
developer can ship a working form backend because the entire product is
*one public Create endpoint plus a delivery pipeline*. In suite terms
that is a public `create` policy on a nested collection plus
event-driven delivery — which means every feature of this product is an
exercise of a suite branch, and its build order IS the suite's
implementation priority. This spec is an APPLICATION spec: it imports
suite norms by reference and is normative only for this product
(umbrella law: nothing suite-normative lives in an application).

## 1. Product thesis and non-goals

The product is **declarative backend primitives**, not hosted compute:

- IN: forms/submissions, delivery (email/webhook), access keys, files,
  quotas, dashboards — each an AEP resource collection with bindings.
- OUT (non-goals, recorded so absence reads as decision):
  - **User-supplied functions.** Transitions + declarative bindings +
    the jobs pipeline are the extensibility model. Hosting arbitrary
    user code is a different product.
  - GraphQL (suite umbrella §3a — rejected).
  - Realtime in v1 (suite umbrella §3a — deferred; MUST use aep/events
    grammar when it lands).

### 1a. Positioning vs saasignal

saasignal (higher-level SaaS for APIs) hosts infra primitives and
opinionated domain orchestrations for API BUILDERS; mizan-gpp hosts
declarative, AIP-compliant primitives for BEGINNERS and AGENTS. The
boundary in practice: where saasignal ships a hosted commerce/booking
module, mizan-gpp ships a dialect TEMPLATE the user owns and edits in
the CMS; where saasignal exposes KV/locks/sketches, mizan-gpp exposes
only primitives with a static-HTML story (forms, counters). Shared
conventions where the surfaces meet: agents.md §4.

### 1b. Three configuration surfaces, one write surface

Builders configure their account through the website, through MCP, or by
syncing a git repo (`hono-aep-baas-config/` in their own project —
baas/sync.md). All three are clients of the same API (sync.md §1's law),
so capability parity across them is automatic, and a pure-HTML project
(config dir + static frontend) is fully reproducible from `git clone`.

## 2. Resource model

AIP-122/124 hierarchy; tenancy is the resource tree, not org machinery:

```
users/{user}                       (platform accounts — better-auth)
projects/{project}                 (owner: user)
projects/{project}/forms/{form}
projects/{project}/forms/{form}/submissions/{submission}
projects/{project}/keys/{key}      (instance data, never in envelopes)
```

- A `project` is an owner-policied resource; everything nests under it.
  Owner pushdown on List gives per-tenant isolation with the EXISTING
  policy engine — no grants, no scoped roles in v1.
- **Owner-of-ancestor rule:** nested resources are policied by the root
  project's owner. v1 mechanism: a creation hook denormalizes `owner`
  onto every nested row (the policy evaluator stays unchanged). The
  traversal form — and per-instance sharing — arrive with the authz
  `grant` predicate (TODO(baas), v2).
- Resource shapes are defined in the app DIALECT, not here — the
  contract is the source of truth (suite law 2); this spec constrains
  what the dialect must express.

## 3. Feature → suite branch dependency

The demand map. Statuses live in `/STATUS.md`; deferred branches carry
a `TODO(baas)` marker at their definition site in the suite specs
(grep-able: `grep -rn "TODO(baas)" customPackages/*/spec customPackages/*/CHECKLIST.md`).

| Feature | Suite branch | Phase |
|---|---|---|
| Hosted submission endpoint | methods/policies (implemented) | 1 |
| Agent discovery surface + health probes | seo surface (implemented) + probes (agents.md §1–2) | 1 |
| Owner dashboard | generated admin + owner pushdown (implemented) | 1 |
| Async delivery + retries | jobs kind | 1 |
| Event fan-out | aep/events EMITTER in hono-aep | 1 |
| Owner email + autoresponder | notifications kind | 1 |
| Outbound webhooks | connections producer | 1 |
| Access keys | authn apiKeys (baas/keys.md) | 1 |
| Captcha/challenge | forms.md §2 (new binding) | 2 |
| Counters (`:increment`, SVG badge) | counters.md | 2 |
| Per-project MCP endpoint | aep/mcp bridge + surface.md (implemented: `{BASE}/mcp`, both planes, nests) | 1 |
| Git config sync (`sync diff/push/pull`) | baas/sync.md — Apply-driven, sk_ auth | 2 |
| Idempotent data seed (`seed diff/push/pull/destroy`, lock ledger, demo principals) | baas/seed.md — the data-plane sibling of sync | 2 |
| Embedded in-page payment (neutral gateway, swappable drivers) | gateway spec (hono-aep-gateway) + commerce.md §3.2 | 3 |
| Abstract delivery (virtual downloads → couriers/parcels, driver-neutral) | delivery spec (hono-aep-delivery) + commerce.md §3.4 | 3 |
| Hosted themes (tweakcn documents → one `<link>` tag) | baas/site.md §1 | 2 |
| Hosted Puck pages + BLOCK fragments ("a cms for some pages — or just some sections") | baas/site.md §1 + collections | 3 |
| Static-SPA PWA + SEO/AEO (artifacts reified at build; prerender; installable off Pages) | baas/site.md §2 | 3 |
| Admin panel in the consumer SPA (contract-driven, white-label) | baas/site.md §3 + auth pools | 3 |
| Rate limits + quotas | baas/quotas.md (promotion candidate) | 2 |
| CSV export | AEP-153 | 2 |
| Attachments | media (mostly implemented) | 2 |
| Free-tier entitlements | billing kind | 3 |
| Per-project dashboards + deliverability card | observability kind | 3 |
| Plan gating | flags kind | 3 |
| Submission search | search kind (CEL filters suffice until then) | 3 |
| Hosted collections (baas/collections.md — THE flagship) | developer meta-API multi-tenant + field branches | 3 |
| Commerce (products/cart/order + event taxonomy) | baas/commerce.md — composes collections/billing/notifications/search/connections | 3 |
| End-user auth pools (baas/auth-pools.md) | authn kind per project | 3 |
| Payments (customer link, intents, inbound webhooks) | billing kind + connections inbound | 3 |
| Key delegation/limits/expiry (keys.md §2a) | authn apiKeys extensions | 3 |
| Template gallery (commerce/booking/etc. as dialect bundles) | meta-API + blocks | 3 |
| Live submission inbox (realtime) | umbrella §3a realtime, aep/events | 3 |

## 4. The `TODO(<project>)` convention

`PLANNED` in a suite spec means design-complete-not-built.
`TODO(<project>)` additionally marks a branch DEMANDED by a named
project — it answers "who is waiting on this." Markers live in the
branch's own spec text (so they version with the spec), spec-check
inventories them (informational), and a project's phase ordering lives
in that project's spec, never in the marker.

## 5. Conformance

- Every suite gate applies unchanged: round-trip law, spec-check,
  site-health, safe-publish.
- Every feature ships with its report card (suite law 6) — a form's
  card audits delivery health, spam posture, and quota headroom.
- The public submission surface MUST remain consumable from static
  HTML with zero JavaScript (the founding constraint; JS enhances,
  never gates).

## 6. References

- baas/forms.md, baas/keys.md, baas/quotas.md, baas/agents.md,
  baas/counters.md, baas/sync.md, baas/collections.md, baas/auth-pools.md,
  baas/site.md, baas/commerce.md
- Flagship consumer: the saastarter port (packages/saastarter surveyed;
  richPetShop2 remains the minimal example)
- Suite umbrella (`customPackages/spec/README.md`) §2 laws, §3a register
- AIP-122/124/133; AEP-151/153/155; aep/events; web3forms (survey)
