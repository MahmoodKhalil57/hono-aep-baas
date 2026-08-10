# reseller.md — white-label child projects

Status: v1 (2026-08-10). Depends: auth-pools.md, keys.md, secrets.md,
site.md §2 (hosted assets), quotas.md/counters.md (metering, spec'd).

## 0. The claim this spec makes true

A project on the platform (the RESELLER — e.g. `bastarter`) can
white-label the entire baas: its own static console, its own user base
(its auth pool), its own branding — and its customers' projects lose
NO capability relative to consuming the platform directly, because a
child project IS a platform project. The reseller adds a namespace,
an attribution edge, and (later) a markup; it never re-implements or
proxies execution. A consumer template (saastarter2-class) points its
`endpoint` at the same executor and its `project` at the child id —
`cli.sh init` is the whole migration.

## 1. Reseller mode

The reseller's project document opts in:

```json
{ "site": { "reseller": { "enabled": true, "childPrefix": "b1" } } }
```

(Under `site` — the consumer-facing config surface — so no schema/
column change is needed; the platform reads it like any site config.)

Requires the reseller project to declare an `auth_pool` — the
reseller's END-USERS are the ones who self-serve child projects.

## 2. Delegated provisioning

`POST /v1/projects/{reseller}/projects` — authorized by the
RESELLER'S POOL (bearer token from `/v1/projects/{reseller}/auth/*`),
not by a platform account:

- Body `{ "display_name": "…" }`, optional `?id=` (AEP-122, prefixed
  with `{childPrefix}-` when configured — children live in the
  reseller's namespace).
- Creates a real platform project whose `created_by` is the DELEGATED
  PRINCIPAL id `pool:{reseller}:{poolUserId}` — a namespace that can
  never collide with platform account ids, so every existing owner
  check (`created_by === principal.userId`) works unchanged.
- Response: the project row **plus `owner_key`** — an sk_ key minted
  against the same delegated principal, returned ONCE (keys.md
  discipline). This key is the child's whole management surface: CLI
  sync/seed/secrets, generated admin, MCP, any console.
- `GET /v1/projects/{reseller}/projects` (same pool auth) lists the
  caller's own children. `POST …/{child}/keys:remint`? Not v1 —
  losing the key means creating a new child (or reseller-owner
  intervention); key management follows keys.md when it lands.

The child is otherwise indistinguishable from any project: all of
`/v1/projects/{child}/**` (collections, themes, pages, forms, auth
pools, commerce, media, secrets, site assets, schemas, MCP) works
under the owner key. That is the no-capability-loss guarantee — it is
structural, not aspirational.

## 3. Branding

Already-hosted surfaces make the reseller's face complete without new
mechanism: the reseller's static console (bastarter's `console.html`
pattern) signs users up against the RESELLER pool and provisions via
§2; child site assets, schemas and admin come from the platform host.
A reseller MAY front the executor with its own hostname (Workers
custom domain / CNAME) so `endpoint` reads as the reseller's — pure
infra, no contract change.

## 4. Attribution and metering (forward)

Children carry `reseller: {reseller}` in their project row. Wide
events already carry `project`; counters.md/quotas.md attribute
child usage to the reseller for markup/limits when implemented. Out of
scope v1: billing, per-reseller quotas, child transfer/adoption to a
platform account.

## 5. Non-goals

- Proxying or re-hosting execution (a reseller is a namespace + a
  face, never a second executor).
- Reseller access to child DATA (the delegated principal owns the
  child; the reseller owner does not pass its owner checks — support
  access is a future, explicit grant).
