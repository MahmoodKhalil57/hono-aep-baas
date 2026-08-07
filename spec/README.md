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
| Owner dashboard | generated admin + owner pushdown (implemented) | 1 |
| Async delivery + retries | jobs kind | 1 |
| Event fan-out | aep/events EMITTER in hono-aep | 1 |
| Owner email + autoresponder | notifications kind | 1 |
| Outbound webhooks | connections producer | 1 |
| Access keys | authn apiKeys (baas/keys.md) | 1 |
| Captcha/challenge | forms.md §2 (new binding) | 2 |
| Rate limits + quotas | baas/quotas.md (promotion candidate) | 2 |
| CSV export | AEP-153 | 2 |
| Attachments | media (mostly implemented) | 2 |
| Free-tier entitlements | billing kind | 3 |
| Per-project dashboards + deliverability card | observability kind | 3 |
| Plan gating | flags kind | 3 |
| Submission search | search kind (CEL filters suffice until then) | 3 |
| Per-project end-user auth pools | authn multi-instance | 3 |
| User-defined collections (meta-API as product) | developer meta-API multi-tenant | 3 |

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

- baas/forms.md, baas/keys.md, baas/quotas.md
- Suite umbrella (`customPackages/spec/README.md`) §2 laws, §3a register
- AIP-122/124/133; AEP-151/153/155; aep/events; web3forms (survey)
