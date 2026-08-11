# secrets.md — per-project secrets (the self-serve keystone)

Status: v1 (2026-08-09). Depends: keys.md (owner auth), auth-pools.md,
commerce.md, sync.md (the `$schema` convention).

## 0. Why this exists

The layer-3 flow is: a stranger signs up on the hosted baas, creates a
project, downloads owner creds — and from then on runs EVERYTHING
through the studio, the MCP, or the config/seed repos. Before this
spec, two config surfaces silently depended on the OPERATOR's worker
env: `auth_pool` EnvRefs resolved against `process.env` (the layer-2
owner's wrangler secrets), and the payment gateway used the operator's
global `STRIPE_*` keys. A layer-3 user could configure auth and
commerce *shapes* but not their *credentials* — not self-serve.

## 1. The store

`/v1/projects/{p}/secrets` — a WRITE-ONLY value store, owner-gated
(the project's `created_by` principal, session or sk_ key):

- `GET  /secrets` → `{ results: [{ name, digest, update_time }] }` —
  names and an 8-hex sha256 prefix. **Values are never readable.**
- `PUT  /secrets/{NAME}` body `{ "value": "…" }` → `{ name, digest }`.
  `NAME` matches `^[A-Z][A-Z0-9_]*$`.
- `DELETE /secrets/{NAME}` → 204.

Storage: `json_rows` scope `projects/{p}`, collection `__secrets`
(reserved; double-underscore collections are invisible to JIT dispatch,
list surfaces, and search). No migration required.

## 2. The resolution ladder

Wherever project config carries `{"$env": "NAME"}` the server resolves:

1. the project's own secret `NAME`, else
2. the worker env (operator-provided shared fallback), else
3. unresolved (the consumer treats the feature as unconfigured).

Consumers in v1:

- **Auth pools** (auth-pools.md): the pool is constructed with
  `{...workerEnv, ...projectSecrets}` — a project setting
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` gets its own OAuth app.
- **Commerce gateway** (commerce.md §4/gateway.md): when a project's
  secrets include `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY`
  (optionally `STRIPE_WEBHOOK_SECRET`), embedded checkout uses a
  project-scoped gateway instance; otherwise the operator's global
  gateway (if any) is the fallback. Money flows to the PROJECT owner's
  Stripe.

Secret writes invalidate the project's cached pool and gateway
instances — the next request rebuilds with fresh values.

Out of scope v1 (spec'd, not built): per-project inbound webhook
verification uses the project's `STRIPE_WEBHOOK_SECRET` when set (the
consumer instance is still constructed globally today); secrets in
notification/email providers.

## 3. The config-repo surface

`hono-aep-baas-config/secrets.cms.json`:

```json
{
  "$schema": "https://…/v1/schemas/secrets-config.json",
  "GOOGLE_CLIENT_ID":     { "$env": "GOOGLE_CLIENT_ID" },
  "GOOGLE_CLIENT_SECRET": { "$env": "GOOGLE_CLIENT_SECRET" },
  "STRIPE_SECRET_KEY":    { "$env": "MY_STRIPE_SK" }
}
```

Values are literals or EnvRefs resolved by the SYNC CLIENT at push
time — secret values never live in git, and never appear in
`sync pull` output. Drift detection is by digest: `sync diff` compares
the local value's sha256 prefix against the listed digest; `sync push`
PUTs only differing names. Deleting a name from the file +
`push --prune` deletes the secret.

### 3.1 .platform-creds.json — the local value store

EnvRefs resolve from, in order: **`.platform-creds.json`** (looked up
in the config/seed dir, then its parent — the repo root, a GITIGNORED
sibling of `.owner-creds.json`), then the process env. The file is a
flat `NAME → value` map (`$schema`: the hosted `.platform-creds.json`
kind), mode 600. This is how a layer-3 user SEES their secret values
locally: owner-creds identifies them to the platform,
platform-creds holds the credentials their project hands to
third parties (OAuth apps, Stripe, …). Both files together are the
complete portable identity of a deployment. `seed` resolves its
EnvRefs (e.g. seeded user passwords) through the same ladder.

## 4. Non-goals

- Reading values back (write-only is the contract; rotate, don't read).
- Encryption beyond the platform's at-rest guarantees (D1) — the
  operator can already read their own database; the boundary this
  store draws is project-vs-project and API-vs-values.
- Arbitrary per-collection secrets — this is project-level config.
