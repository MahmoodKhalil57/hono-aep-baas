# connect.md — click to connect, instead of paste a token

Status: v1 (2026-08-11). Depends: secrets.md (where the credential lands),
dns.md (the first consumer), surface.md §1 (BASE), domains.md (custom
origins), interface.md (the studio).

## 0. The claim

Minting an API token by hand is the worst step in the product. The user
leaves, finds a settings page they have never seen, picks permissions from a
list of hundreds, scopes it to the right resource, copies a value that is
shown once, and pastes it back — and every mistake surfaces later, as a
failure in an unrelated call.

Providers already solve this: **the user clicks Connect, reads what is being
asked in the provider's own words, and approves.** This spec is that flow.

The credential lands in exactly the place a pasted one does — the project's
secret of the same name — so every consumer is unchanged and cannot tell the
difference. `dns.md`'s `:provision` required no edit.

## 1. Per-provider reality

| provider | click-to-connect | mechanism |
| --- | --- | --- |
| **Cloudflare** | **yes** | OAuth 2.0, Authorization Code + PKCE (S256), self-managed client (`POST /accounts/{id}/oauth_clients`) |
| **GitHub** | yes, later | GitHub **App** installation — the user picks repositories, and we mint 1-hour tokens rather than holding one. Not built: no baas capability consumes a repo yet |
| **Stripe** | **no** | Connect's `access_token`/`refresh_token` are deprecated in favour of `Stripe-Account` with the platform's own key. That is a business-model change (becoming a Connect platform, accepting merchant-risk obligations), and it would replace the per-project `STRIPE_WEBHOOK_SECRET` that is currently the tenant boundary. Stays paste — see pricing.md §1.1 |

**Cloudflare's device flow is not available to third-party clients**, so the
existing device-flow code (`hono-aep-cms/src/github.ts`) does not transfer.

**Paste never goes away.** It is the fallback when a provider has no flow
(Stripe), when an org blocks third-party OAuth apps, and when a deployment
has registered no client. `:connect` answers 409 in that last case and says
so.

## 2. Shape

```
POST {BASE}:connect             { "provider": "cloudflare" }  → { authorize_url, state, expires_time }
GET  {PLATFORM}/connect/callback?code&state                   → exchanges, parks, renders
POST {BASE}:claim-connection    { "state": "…" }              → { provider, secret }
```

Both verbs are on **project**, not on a credential resource, and that is
load-bearing rather than incidental: `customPolicyGuard` resolves an owner
policy by loading the target row *before* the handler runs, so a verb whose
own row does not exist yet answers 404 on the first call — forever. A project
row always exists.

## 3. The callback

Registered as **one fixed URI on the platform origin**. OAuth requires an
exact pre-registered value, and a tenant-supplied one would let a project
point the callback at a host it controls and harvest authorization codes.

It is handled **before** domain resolution and **refused on any other host**.
Both are required: on a resolved custom host every path outside
`/v1/projects/` is rewritten into that project's surface (domains.md §3),
which would swallow the route; and a callback arriving on a tenant's host is
a misconfiguration at best.

The callback **renders a page; it does not redirect back**. The flow may have
started on a custom domain, where no platform session exists (domains.md §7.6
requires host-only cookies), so bouncing the user there would land them
signed out. Returning them to a surface they are not authenticated on is
worse than asking them to switch tabs.

## 4. Why there is a claim step

The callback arrives from the provider, not from a signed-in user, so it
cannot be owner-gated the usual way. Committing the grant there loses to a
**reverse-CSRF**:

> Mallory starts a flow on HER project, sends the start link to Alice, Alice
> consents with HER Cloudflare account — and Alice's grant is spent on
> Mallory's project.

Neither obvious binding fixes it. A browser cookie is minted in *Alice's*
browser, so it proves nothing about who the flow belongs to. Binding to the
starting principal does not help either, because Mallory legitimately *is*
that principal.

So committing requires **both**, and in the attack they are held by different
people:

| | has the flow cookie | has the starting session |
| --- | --- | --- |
| Alice (consented) | yes | no |
| Mallory (started) | no | yes |

Neither can claim, and the grant expires unused. That is the entire reason
this flow has three steps instead of two.

## 5. Requirements

1. `:connect` requires the project **owner**; anonymous is 401.
2. State is ≥256 bits of CSPRNG output, single-use, and expires in 15 minutes.
3. PKCE S256 on every flow. The verifier never leaves the server.
4. The flow cookie is `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`
   — Lax specifically, because a Strict cookie is not sent on the provider's
   cross-site redirect back and the flow would never complete. Only its
   **digest** is stored; the value is never persisted.
5. `:claim-connection` MUST verify all four of: the flow exists and is
   unused, the caller is the starting principal, the project matches, and the
   cookie digest matches. Any mismatch is a 409 that does not distinguish
   which — a caller learning *which* check failed learns whether a state is
   real.
6. The callback MUST NOT store a credential. It exchanges and parks.
7. Single-use is marked **before** the credential is written, so a replay
   cannot re-commit if the write is retried.
8. A provider error body MUST NOT be surfaced — it can echo request
   parameters. Status only.
9. Client credentials are **worker secrets**, never rows. Absent ⇒ the
   feature is off, and `:connect` says so rather than half-working.
10. The obtained credential is stored under the SAME secret name a pasted one
    would use, so consumers need no knowledge of its provenance.
11. Abandoned flows are swept; an unclaimed grant is a live credential.

## 6. Not built

- **Refresh.** Cloudflare returns a refresh token when `offline_access` is
  granted; nothing refreshes it yet, so a connection outlives its access
  token only until that token expires. The next call fails with a
  reconnect-shaped problem rather than silently falling back.
- **Upstream revocation on disconnect.** Deleting the secret stops us using
  it; it does not tell Cloudflare. The revoke endpoint is known and unused.
- **A `credential` resource.** There is no listing of what is connected
  beyond `GET /secrets` showing the name. The studio can show connected/not
  from that; richer metadata (account id, granted scopes, expiry) has nowhere
  to live yet.
- **GitHub and Stripe** (§1).
- **Scope verification.** dns.md §4's caveat is unchanged in substance: the
  grant response is a better scope oracle than a pasted token, but nothing
  reads it yet.

## 7. UNVERIFIED

- **The scope strings.** `zone:read dns_records:edit offline_access` is a
  reasonable guess, not a confirmed set; the authoritative list comes from
  `GET /oauth/scopes` against a registered client. `CF_OAUTH_SCOPES`
  overrides them without a deploy. Wrong scopes fail at the consent screen,
  which is the safe direction, but do not treat the default as confirmed.
- **The endpoint paths** (`/oauth2/auth`, `/oauth2/token`, `/oauth2/revoke`)
  come from research, not from a flow this repo has run. `CF_OAUTH_BASE`
  overrides the origin.
- Nothing here has run against real Cloudflare. Every test drives a stub.

## 8. Conformance

1. Anonymous and non-owner `:connect` are refused.
2. The authorize URL carries `code_challenge_method=S256` and a state that
   matches the returned one.
3. Consent alone stores nothing.
4. Owner + same browser + matching project completes and writes the secret.
5. The reverse-CSRF (§4) is refused for BOTH parties, and no secret is
   written.
6. A claim naming a different project than the flow started on is refused.
7. A replayed claim is refused.
8. An unknown or forged state is refused at the callback.
9. The callback is refused on any host but the registered one.
