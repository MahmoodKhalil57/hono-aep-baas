# surface.md — one contract, four consumers, recursively

Status: v1 (2026-08-10). Depends: collections.md, interface.md, auth-pools.md
§3a (nested addressing), aep/mcp (the bridge), sync.md §6 (hosted schemas).

## 0. The claim

A project is ONE resource model. Everything a consumer touches — the public
frontend, the admin, the studio, an agent — is a **projection** of that one
model. There are exactly two planes and two machine projections:

| | definition plane | data plane |
| --- | --- | --- |
| **what** | collections, themes, pages, forms, site, services, secrets, keys | the project's JIT collections' rows |
| **who edits it** | the studio | the admin |
| **who reads it** | agents, tooling | the frontend, agents |

| projection | artifact | consumer |
| --- | --- | --- |
| **HTTP** | the routes + `{BASE}/openapi.json` | frontend, studio, admin, any client |
| **MCP** | `{BASE}/mcp` | agents |

Both projections are DERIVED from the same model, cover BOTH planes, and are
enforced by the same policies. A capability reachable over HTTP MUST be
reachable over MCP, and vice versa (one-write-surface law): the projections
differ in encoding and ergonomics, never in reach.

## 1. The recursion law (the load-bearing rule)

Projects nest without limit (auth-pools.md §3a):

```
/v1/projects/{p}                                  depth 1
/v1/projects/{parent}/projects/{child}            depth 2
/v1/projects/{a}/projects/{b}/projects/{c}        depth 3 …
```

A project MAY also be reachable at its own domain (domains.md), which is a
third spelling of the same idea — an origin instead of a path prefix. Both
feed the one **BASE**, so the law below governs domains too.

Call the caller-visible project path the **BASE**. Then:

> **LAW.** Every generated artifact MUST be expressed relative to the BASE of
> the *incoming* request. No generator may hardcode `/v1/projects/{id}` or
> reconstruct a path from the project id alone.

This covers `servers[].url` in OpenAPI, every absolute URL in a generated
document (site assets, `$schema` refs, studio/admin deep links, `llms.txt`
links), and every path an MCP tool reports or accepts. Obey it and nesting is
a pure prefix operation — depth N costs no new code path. Violate it in one
generator and that artifact silently points a nested consumer at the flat
surface.

### 1.1 Why this needs a mechanism (not just discipline)

The nested rewrite UNWRAPS before dispatch: `/v1/projects/{a}/projects/{b}/x`
is rewritten to `/v1/projects/{b}/x` and re-entered, so **downstream handlers
never see the caller's path**. The BASE is destroyed by design — that is what
makes nesting free — so it MUST be carried alongside.

**Mechanism.** The rewrite accumulates an **ancestor chain**. At each step the
parent is appended; the innermost handler reconstructs:

```
BASE = "/v1" + ancestors.map(a => `/projects/${a}`).join("") + `/projects/${current}`
```

Depth 3 worked example — request `/v1/projects/a/projects/b/projects/c/mcp`:

| step | matched | inner path | ancestors |
| --- | --- | --- | --- |
| 1 | parent `a`, child `b` | `/v1/projects/b/projects/c/mcp` | `[a]` |
| 2 | parent `b`, child `c` | `/v1/projects/c/mcp` | `[a,b]` |
| — | handler sees project `c` | | → BASE `/v1/projects/a/projects/b/projects/c` |

**Security.** The ancestor chain is INTERNAL state. Because the rewrite
forwards the caller's headers, an inbound request MUST NOT be able to declare
its own ancestry: the carrier MUST be stripped from every ingress request
before dispatch. A forged chain would let a caller mint documents advertising
a surface it does not own. Ancestry is only ever appended by the rewrite,
which has already verified `created_by` ownership.

### 1.2 Known defect this law repairs

`{BASE}/openapi.json` currently emits `servers[].url` from the *rewritten*
project id, so a document fetched at
`/v1/projects/bastarter/projects/saastarter3/openapi.json` advertises
`/v1/projects/saastarter3` — the flat base. Clients generated from a nested
document therefore address the wrong surface. Same class of defect applies to
any generated absolute URL. Fixing this is a conformance requirement, not an
enhancement.

## 2. Projection A — HTTP + the dynamic OpenAPI

`{BASE}/openapi.json` is the complete, live HTTP contract for that surface. It
MUST enumerate **both planes** and regenerate from the project's current
state (a collection applied a second ago appears without a deploy):

| group | operations |
| --- | --- |
| data plane | every JIT collection: list/get/create/update/delete + declared custom verbs |
| definition plane | collections, themes, pages, forms (the meta-resources) |
| project doc | site, services, secrets, keys |
| auth | the project's pool endpoints, when `auth_pool` is declared |
| interfaces + assets | `studio`, `admin`, `site/*` |
| children | `projects` (the nested list), when the surface has any |

Requirements:

1. `servers[].url` MUST be the BASE (§1).
2. Operations carry their `x-hono-aep-policy` so a reader can see reach
   before calling, and `x-aep-ui` so a renderer can generate an interface
   (this is what `bootstrap-ui` and the admin already consume).
3. It MUST be the same document the studio, the admin, and the no-build
   renderer consume — one contract, not a doc-only copy.

## 3. Projection B — MCP (`{BASE}/mcp`)

The bridge is the suite's contract-generated MCP server (aep/mcp), mounted
per surface. It is stateless (MCP `2026-07-28`), so a project's MCP endpoint
is exactly its BASE plus `/mcp` at any depth, with no per-project process,
session, or registration.

1. **`describe` spans both planes.** It MUST return the definition-plane
   meta-resources AND the data-plane JIT collections in one model, each row
   tagged with its `plane` (`"definition"` | `"data"`). This is what lets ONE
   endpoint drive the studio, the admin, and the frontend: an agent that can
   `describe` can then create a collection (definition) and immediately write
   rows into it (data) through the same seven verbs.
2. **Tools stay generic.** The seven verbs (`describe`, `list`, `get`,
   `create`, `update`, `delete`, `call`) are unchanged; adding a collection
   MUST NOT add a tool. The domain lives in `describe`'s output.
3. **Paths are BASE-relative.** Tool arguments and reported paths are
   relative to the surface (`products/42`), never absolute and never
   flat-rewritten. Deep links returned to operators use the BASE (§1).
4. **Two tiers, cross-referenced.** `describe` is the cheap orientation tier;
   `{BASE}/openapi.json` is the full-fidelity tier. Each names the other with
   a cost hint (aep/mcp §4.3).

## 4. Auth parity

Both projections resolve the principal through the SAME chain, so reach is
identical whichever a consumer picks:

| principal | reaches |
| --- | --- |
| project `sk_` key | the project's own surface |
| owner session (the pool named by `created_by`) | the project it owns — including a parent driving its child |
| pool member session | the project's end-user surface, under its policies |

Because credentials are per-request input rather than connection state
(MCP is stateless), the advertised tool set and the enumerated operations MAY
vary by authorization — never by connection or by depth.

**Corollary (the recursion payoff).** A parent's agent surface over a child
IS the child's own agent surface — the same statement interface.md §1 makes
for the studio/admin renderers. `bastarter` drives `saastarter3` over MCP
with its owner session at
`/v1/projects/bastarter/projects/saastarter3/mcp`, and `saastarter3` drives
itself with its own key at `/v1/projects/saastarter3/mcp`. Same model, same
policies, same tools — different BASE.

## 5. Conformance

1. **Base-relative.** For every generated artifact, the flat and nested
   fetches are byte-identical except for the BASE they advertise.
2. **Depth.** A depth-3 surface works with no code specific to depth.
3. **No forged ancestry.** An inbound request that declares its own ancestor
   chain is rejected/stripped; ancestry is only appended by the ownership-
   verified rewrite.
4. **Parity.** Every capability in `{BASE}/openapi.json` is reachable through
   the MCP verbs, and neither projection exposes reach the other lacks.
5. **Both planes.** `describe` and `openapi.json` each enumerate the
   definition plane and the data plane, tagged.
6. **Liveness.** Applying a collection changes both projections on the next
   request, with no redeploy.

## 6. Non-goals v1

- Per-project MCP OAuth discovery (`/.well-known/oauth-protected-resource`)
  — PLANNED (agents.md §3); keys and sessions cover v1.
- MCP `resources/*` and `prompts/*` (aep/mcp §7-§8 PLANNED).
- Capability profiles / permission-filtered tool advertisement
  (aep/mcp §5.4-§5.5 PLANNED) — policies still enforce at call time, so this
  is ergonomics, not reach.
