# Agent Surface

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/agents`
**Status:** draft

The product serves beginners AND agents; the agent is a first-class
consumer, not an afterthought. Survey basis: saasignal's API-host meta
surface (skill file, llms indexes, OAuth discovery, health probes) and
its MCP-from-operationId registration.

## 1. Discovery on the API host (phase 1)

The API origin itself — not just the marketing site — MUST serve:

| path | content |
|---|---|
| `/llms.txt`, `/llms-full.txt` | spec-compliant index + compact route reference (suite seo surface, pointed at the API) |
| `/skills/baas` | an agent playbook: when to use MCP vs REST vs plain HTML embed, how tool names map to `operationId`s |
| `/to-humans.md` | the inversion of llms.txt — where the humans should go |
| `/openapi.json` | the authoritative contract (already generated) |
| `/docs` | Scalar over the contract (already generated) |
| `robots.txt` + `sitemap.xml` | the meta endpoints, crawlable |

## 2. Health probes (phase 1)

Kubernetes-style, generated from the seams: `/livez` (process alive),
`/readyz` (storage seam ping, 503 when degraded), `/healthz` (combined,
+ version + uptime). These belong in the suite (a generated probe over
the storage seam), not hand-written per app — tracked as a PLANNED
branch on the observability kind.

## 3. Per-project MCP

Every project gets its own MCP endpoint, generated from ITS contract —
the suite's bridge already derives tools from the contract, so this is
key-scoping plus routing, not new machinery. A form owner points an
agent at `{BASE}/mcp` with an `sk_` key and the agent can read
submissions, manage forms, and drive transitions under the same
policies as HTTP callers (aep/mcp safety model: profiles,
permission-filtered advertisement).

**Normative detail lives in `surface.md`** — the per-project MCP endpoint
and the dynamic `openapi.json` are the two machine projections of one
resource model, both spanning the definition and data planes, both
base-relative so they recurse through nested projects at any depth.

PLANNED beyond keys: MCP OAuth per the MCP authorization spec —
`/.well-known/oauth-protected-resource` discovery so browser-authorized
agents need no manual key handling.

## 4. Conventions shared with saasignal

Where the two products' surfaces meet, they use the same conventions so
tooling transfers: `sk_`/`pk_` key prefixes (keys.md), HMAC-signed
webhook envelopes (connections/Standard Webhooks), server-generated
request id echoed in a response header with the client's id echoed
separately, per-request usage headers beside the RateLimit fields
(quotas.md).

## 5. References

- baas/README.md §3, baas/keys.md, aep/mcp, observability kind
- saasignal backend (survey subject; higher-level SaaS for APIs — the
  positioning boundary is: saasignal hosts infra/domain orchestrations
  for API builders, mizan-gpp hosts declarative primitives for
  beginners and agents)
