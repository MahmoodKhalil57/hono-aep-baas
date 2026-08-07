# Access Keys

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/keys`
**Status:** draft

## 1. Two key classes (Stripe naming, web3forms semantics)

The web3forms insight: the key embedded in public HTML is not a secret
— it *identifies* the form; abuse controls compensate. Making that
explicit yields two classes with different threat models:

| class | prefix | secret? | grants | compensating controls |
|---|---|---|---|---|
| **publishable** | `pk_` | NO — lives in public HTML | `create` on one form's submissions, nothing else | domain allowlist, challenge, rate limits, quotas (forms.md §2, quotas.md) |
| **secret** | `sk_` | YES — server-side only | the owner's management surface (scoped) | standard credential handling; never in client code |

## 2. Requirements

1. Keys are **instance data** (rows behind the API, keys.md hierarchy —
   never in service envelopes; cms/service-instance.json
   definition-vs-data invariant). Stored hashed; the plaintext is shown
   once at creation.
2. A publishable key binds to exactly ONE form (narrowest useful
   scope); a secret key binds to a project and carries an explicit
   scope list checked by the SAME policy vocabulary as session
   principals — a key is just another way to arrive at a Principal
   (`auth/authz.json`), never a bypass.
3. Rotation: keys are created/revoked, never edited; `revoked_at` keys
   fail closed immediately. The form's HTML keeps working through
   rotation because `/submit/{key}` aliases resolve any non-revoked key
   of the form.
4. Prefixes (`pk_`/`sk_` + environment tag) make leaked-key triage
   grep-able — a `sk_` in client code is a report-card failure.

## 3. Suite branch

This implements the authn spec's PLANNED apiKeys branch
(`auth/authn.json`) — the baas is its demand (TODO(baas) at the
definition site). The Principal produced by a key carries
`scopes` from the key row; method policies need no key-awareness.

## 4. References

- auth/authn.json (apiKeys), auth/authz.json (Principal, scopes)
- baas/forms.md §1 (`/submit/{key}` alias), baas/quotas.md
