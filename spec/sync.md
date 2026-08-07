# Git Config Sync

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/sync`
**Status:** draft

## Abstract

A consumer keeps their baas configuration IN THEIR OWN REPO and syncs it
to their account. This makes a pure-HTML project fully reproducible from
git: `richPetShop2/hono-aep-baas-config/` declares the backend,
`richPetShop2/html-frontend/` consumes it, and nothing about the backend
lives only in a dashboard. Sync is NOT a bespoke protocol — it is the
standard AEP Apply method driven by a manifest, so it inherits the
contract's idempotency, ETags, and policies for free.

## 1. One write surface, three clients (law)

The API is the ONLY write surface. The three configuration experiences
are all clients of it:

| surface | what it is |
|---|---|
| the website | the studio/dashboard over the API |
| MCP | the contract-generated bridge (agents.md §3) |
| git sync | Apply-driven, from the consumer's repo |

Consequence: anything expressible in one surface is expressible in all
three, automatically — a new resource kind appears in the dashboard, the
MCP tools, and the syncable file set the moment it enters the contract.
No surface may grow a capability the API does not have.

## 2. The config directory

`<repo>/hono-aep-baas-config/` holds one manifest plus one file per
resource, in the suite's canonical form (sorted keys; the round-trip
law applies — `sync fmt` reprints, and a synced file is byte-identical
to what `sync pull` would write):

```
hono-aep-baas-config/
  baas.json                     # the manifest
  forms/contact.cms.json        # projects/{project}/forms/contact
  forms/newsletter.cms.json
  counters/pageviews.cms.json   # when counters land (counters.md)
```

`baas.json` (illustrative shape):

```json
{
  "endpoint": "https://api.baas.example",
  "project": "richpetshop2",
  "resources": ["forms/*.cms.json", "counters/*.cms.json"]
}
```

TODO(saastarter): the `.cms.css` document type (themes — baas/site.md
§1) joins the manifest globs; same slug-id and canonical-form rules.

Rules (the service-instance registry's invariants, inherited):

1. **Single definition site** — one resource per file, no merging, no
   overriding; relative paths resolve against the file.
2. **The file slug IS the resource id** (AIP-133 client-specified ids):
   `forms/contact.cms.json` ⇄ `projects/{p}/forms/contact`. Renaming a
   file is a delete + create, and `sync diff` says so.
3. **Output-only fields stay out of the repo on push and come back on
   pull**: `submit_key`, `create_time`, `created_by` are server-owned;
   Apply strips them (the contract's stripOutputOnly), and `sync pull`
   reifies them into the file so the frontend's embed key is one
   `sync pull` away — pk keys are publishable by design (keys.md), so
   committing them is safe and CORRECT.
4. **Secrets never appear** — any secret-bearing field is an EnvRef
   (`{"$env": "NAME"}`), resolved account-side (suite law 5).

## 3. Verbs

| verb | semantics |
|---|---|
| `sync diff` | the plan: per file, create / update (field-level) / noop; plus account resources NOT in the repo (prune candidates). Never writes. |
| `sync push` | one Apply (PUT, create-or-replace) per file, in dependency order (project → forms → …). Idempotent: a second push is all noops. Pruning account resources absent from the repo requires the explicit `--prune` flag and lists its deletions first (safe-publish discipline: destructive needs its own consent). |
| `sync pull` | reifies account state into canonical files — the answer to dashboard/MCP edits that should become code. |
| `sync fmt` | canonical reprint of the local files (the round-trip gate). |

CI shape: `sync diff --exit-code` in pull requests (drift visible in
review), `sync push` on merge — the config directory becomes the same
draft → version → publish lifecycle the suite already runs, with git as
the substrate.

## 4. Drift and concurrency

The suite umbrella §3a REJECTED config pull for CMS content because
production there has no write surface — drift is impossible by design.
The baas is the opposite BY DESIGN: three first-class writers exist, so
drift is expected and managed, not forbidden:

1. Every pushed Apply carries `If-Match` from the last known ETag; a
   dashboard edit since the last pull surfaces as 412, and the resolution
   is `sync pull` (adopt), then re-push — never a blind overwrite.
2. `sync diff` before push is the reconciliation ritual; CI makes it
   continuous.
3. Per document, last writer wins; there is no merge — documents are
   small and single-concern precisely so this is acceptable.

## 5. Authentication

Sync authenticates with a **secret key** (`sk_`, keys.md) carrying
exactly the scopes the manifest needs — a key is a Principal; the same
policies that guard the dashboard guard sync. Publishable keys cannot
sync (their grant is submission-only). The key arrives via environment
(`BAAS_KEY`), never the manifest.

## 6. The consumer-repo pattern (worked example)

```
richPetShop2/
  hono-aep-baas-config/     # the backend, declared (this spec)
  html-frontend/            # pure HTML/CSS; no build step required
    index.html              #   <form action="{endpoint}/submit/pk_live_…">
    thanks.html
```

The frontend needs exactly one value from the backend — the form's
publishable key — and `sync pull` delivers it into the form's file.
Deploying the frontend is any static host; deploying the backend is
`sync push`. The whole product is two directories in one repo, and
`git clone` + `sync push` reproduces it from nothing.

## 7. Conformance

- Sync MUST be expressible entirely through the public contract
  (standard methods + ETags); a sync client that needs a private
  endpoint violates §1.
- `sync push` twice in a row MUST be a no-op the second time.
- `sync pull && sync push` MUST be a no-op (round-trip law across the
  wire).
- Destructive operations (prune, file-rename delete halves) MUST be
  explicit-flag + listed-first.

## 8. References

- AIP-133 (client ids), AEP Apply semantics, suite laws 1/2/5,
  cms/service-instance.json (definition-site rules), baas/keys.md,
  safe-publish.md (consent discipline), umbrella §3a (the CMS-side
  pull rejection this section deliberately differs from)
