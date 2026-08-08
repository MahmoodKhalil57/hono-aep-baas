# Idempotent Data Seed

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/seed`
**Status:** draft

## Abstract

A consumer keeps the DATA their system starts from — catalog rows, demo
posts, fixture reviews, demo end-users — in their own repo and applies it
idempotently. `hono-aep-baas-idempotent-seed/` is to the data plane what
`hono-aep-baas-config/` (baas/sync.md) is to the definition plane: one
manifest, one file per row, every write an AEP Apply through the public
contract. Nothing server-side exists for seeding; the entire capability
is a thin client of methods every surface already has — which is what
makes it OPTIONAL by construction (§2).

The problem it solves: "populate my system" is today either a hand-run
script (not idempotent, not reviewable), dashboard clicking (not
reproducible), or bespoke SQL (bypasses policies — forbidden). The seed
makes initial and ongoing data declarative, diffable, and re-runnable,
without ever becoming a second write path.

## 1. The two planes (law)

| plane | directory | carries | spec |
|---|---|---|---|
| definitions | `hono-aep-baas-config/` | collections, forms, themes, project config | baas/sync.md |
| data | `hono-aep-baas-idempotent-seed/` | rows OF those collections; demo principals | this spec |

The separation inherits the service-instance registry's
definition-vs-data invariant: a seed file MUST NOT carry a definition
(no `definition:` envelopes, no `.cms.*` types), and a config file MUST
NOT carry rows. The seed depends on the config having been pushed first
— a seed row for an undeclared collection fails exactly as any API
client's write would (404), and that failure is correct.

## 2. Three adoption postures (all first-class)

1. **Converging repo** — the seed directory is the source of truth for
   the SEEDED SUBSET of data, synced frequently (CI: `seed diff
   --exit-code` in PRs, `seed push` on merge). Drift against
   dashboard/MCP edits is expected and managed (§6).
2. **Run-and-forget** — one `seed push` at project birth; thereafter the
   studio/MCP own the data. The directory stays in git as the
   reproducibility record (clone + config `sync push` + `seed push`
   rebuilds the whole system from nothing), or is deleted once obsolete.
3. **No seed at all** — the studio and MCP write directly. Because the
   seed adds NO server-side machinery and no reserved fields, opting out
   requires zero consideration: there is nothing to disable.

Postures are not commitments. §5's `--adopt` migrates 3 → 1 (hand-made
data reified into files); simply stopping the CI job migrates 1 → 2.

## 3. The seed directory

```
hono-aep-baas-idempotent-seed/
  seed.json                    # the manifest
  seed-lock.json               # the ownership ledger (§5) — committed
  products/saastarter2.json    # projects/{p}/products/saastarter2
  products/billing-kit.json
  posts/hello-world.json
  reviews/first-review.json
  users/demo.json              # demo end-user in the auth pool (§7)
```

`seed.json`:

```json
{
  "endpoint": "https://api.baas.example",
  "project": "my-project",
  "resources": ["products/*.json", "posts/*.json", "reviews/*.json"],
  "users": ["users/*.json"]
}
```

Rules (sync.md §2's, restated for data):

1. **One row per file; the file slug IS the row id** (AIP-133
   client-specified ids): `products/billing-kit.json` ⇄
   `projects/{p}/products/billing-kit`. Renaming a file is a delete +
   create and `seed diff` says so.
2. **Canonical form** — sorted keys, two-space indent, trailing newline;
   `seed fmt` reprints, and a pushed file is byte-identical to what
   `seed pull` writes back (round-trip law, suite umbrella §2.1).
3. **Mutable fields only** — output-only fields (`path`, `create_time`,
   `update_time`, `created_by`, `state`, …) stay out on push and come
   back on pull. A committed seed file is exactly an Apply body.
4. **Secrets never appear** — any secret-bearing value is an EnvRef
   (`{"$env": "NAME"}`) resolved at run time (suite law 5). Demo-user
   passwords (§7) MUST be EnvRefs.
5. **Manifest order is execution order** — globs run in array order,
   files within a glob in filename order. Reference-bearing rows list
   their targets' globs earlier (products before reviews).

Deliberately absent: templating, loops, per-environment overlays,
computed values. A seed is LITERAL data; anything generated belongs in
whatever program the consumer uses to WRITE the files (which then
commits literal output). The manifest's `endpoint`/`project` MAY be
EnvRefs so one directory can target dev and prod accounts.

## 4. Verbs

| verb | semantics |
|---|---|
| `seed diff` | the plan: per file, create / update (field-level) / noop; plus lock-listed rows missing from files (prune candidates) and their inverse (§5 adopt candidates on request). Never writes. |
| `seed push` | per file: GET the row; if the canonical mutable projection already equals the file, do NOTHING (a true no-op — no Apply, no `update_time` churn); else one Apply (PUT, If-Match from the GET). Then update the lock. `--prune` additionally deletes lock-listed rows absent from the files, listing deletions first (safe-publish discipline: destructive needs its own consent). |
| `seed pull` | reify the CURRENT server state of every lock-listed row back into its file — the answer to "we edited in the studio and want it in git". |
| `seed pull --adopt <plural>/<id>` | pull a row the seed does NOT yet own into a new file and the lock — the 3 → 1 migration path. `--adopt <plural>/*` adopts a whole collection's current rows. |
| `seed fmt` | canonical reprint of local files. |
| `seed destroy` | delete every lock-listed row (and only those), then empty the lock. The clean uninstall for fixtures; requires an explicit `--yes`. |

The no-write no-op in `push` is a MUST, not an optimization: Apply
would bump `update_time` and fire `.update` events, so a naive re-push
would spam webhooks/notifications/search-reindex on every CI run. An
idempotent seed is *observably* idempotent — the second run leaves
ETags, timestamps, and the event stream untouched.

## 5. Ownership: the lock ledger

`seed-lock.json` records every row path the seed has ever applied:

```json
{ "rows": ["products/saastarter2", "products/billing-kit", "posts/hello-world"] }
```

- **Prune and destroy MUST only touch lock-listed rows.** User-generated
  data — real orders, real reviews, rows hand-made in the studio — is
  structurally out of reach because it never enters the lock. This is
  the Terraform-state insight applied at row granularity, with git as
  the state store (committed, so the whole team prunes consistently).
- The lock is derived state, never edited by hand; `push`, `pull
  --adopt`, and `destroy` maintain it.
- Losing the lock loses prune/destroy safety, nothing else — `push`
  regenerates ownership going forward, and `--adopt` re-claims rows
  explicitly. (Rejected alternative: in-band `seeded: true` fields on
  rows — pollutes every consumer schema and survives into exports;
  a ledger keeps the data clean.)

## 6. Drift and concurrency

Same posture as sync.md §4 — three writers exist by design, so drift is
managed, not forbidden:

1. Every Apply carries `If-Match` from the read that planned it; a
   studio/MCP edit in between surfaces as 412, and the resolution is
   `seed pull` (adopt their edit) or re-push (assert the file) —
   consciously, never a blind overwrite.
2. `seed diff` is the reconciliation ritual; CI makes it continuous for
   posture 1.
3. Per row, last writer wins; rows are small and single-concern so a
   merge protocol is deliberately out of scope.

## 7. Demo principals (the `users` manifest key)

Fixtures often need signed-in actors (a demo customer with a wishlist, a
reviewer). Pool users cannot be Apply'd — the auth pool's surface is the
only writer of identities (auth-pools.md). The seed therefore drives the
PUBLIC auth surface, idempotently by email:

```json
{ "email": "demo@example.test", "name": "Demo Customer", "password": { "$env": "SEED_DEMO_PASSWORD" } }
```

`seed push`: sign-up; an already-exists answer is the no-op. Rows owned
by a demo user (owner-scoped collections) are seeded by signing in as
that user for exactly the files whose glob is declared with `"as":
"users/demo.json"` in the manifest's resources entry (extended form:
`{"glob": "reviews/*.json", "as": "users/demo.json"}`). Absent `as`,
rows are created by the sk_ principal (§8). Demo users never enter the
lock — `destroy` does not delete identities (anonymization is the
user's own verified flow, auth-pools.md §1.5).

## 8. Authentication

Like sync (sync.md §5): a secret key (`sk_`, keys.md) via environment
(`BAAS_KEY`), never the manifest. The key is a Principal; every seeded
row passes the same policies as any client — `policy_create:
"authenticated"` admits the key, owner fields land as the key's
principal, and a policy the key fails is a seed error, not a bypass.
Publishable keys cannot seed.

## 9. Non-goals

Media/blob seeding (waits for per-project buckets — media.md's
TODO(saastarter)); cross-project seeds (one manifest, one project);
per-environment overlay trees (use two directories or EnvRef'd
manifests); merge resolution beyond last-writer-wins; seeding through
private endpoints (violates §1 of sync.md, inherited); scheduling
(a seed runs when invoked — CI is the scheduler).

## 10. Conformance

- `seed push` twice in a row: the second run MUST issue zero writes
  (no Apply, no event, no `update_time` change) when nothing changed.
- `seed pull && seed push` MUST be a no-op (round-trip across the wire).
- `--prune` and `destroy` MUST delete only lock-listed rows, and MUST
  list deletions before acting.
- The seed MUST be expressible entirely through the public contract; a
  client needing a private endpoint violates this spec.
- A seed file carrying a definition (or a config file carrying a row)
  MUST be rejected by `fmt`/`diff` (§1's plane separation).
- Secret-bearing values MUST be EnvRefs; a literal secret in a seed
  file is a conformance failure.

## 11. References

- baas/sync.md (the definition-plane sibling; §1 one-write-surface law,
  §4 drift, §5 auth — all inherited)
- baas/collections.md (the rows' resource model), baas/auth-pools.md §1.5
  (identities), keys.md (sk_ principals)
- AEP-134 Apply, AIP-133 client-specified ids, AEP-154 ETags
- Suite umbrella §2 laws 1 (round-trip), 5 (secrets by reference),
  6 (audits-not-assertions)
- Terraform state / Kubernetes apply (the ownership-ledger prior art)
