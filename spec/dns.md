# dns.md — BYOK DNS: we write the records, you keep the account

Status: v1 (2026-08-11). Depends: domains.md (the `domain` resource, the
challenge, `:verify`), secrets.md (the write-only per-project store),
pricing.md §1 (the BYOK class), services.md §1 (the provider seam).

## 0. The claim

Publishing a TXT record by hand is the single slowest step in getting a
custom domain working: the user leaves, finds their registrar, pastes a
value, waits, comes back, and calls `:verify` — often more than once,
because they pasted the label wrong.

If they already hold an API credential for that zone, none of that is
necessary. **A project connects its DNS account, and the platform writes the
records.** The `domain` resource, its challenge and `:verify` are unchanged;
this only removes the copy-paste between them.

## 1. What a customer credential can and cannot do

This section exists because the obvious assumption is wrong, and building on
it would produce a feature that appears to work and does not.

**It cannot route.** A Worker is addressed by the PLATFORM's account id, and
Cloudflare refuses a Custom Domain "on a zone you do not own"
(`workers/configuration/routing/custom-domains.mdx:37`). A cross-account
CNAME to `*.workers.dev` fails two ways: unproxied it dies at the TLS
handshake, because that certificate does not cover the customer's name;
proxied it returns **1014 CNAME Cross-User Banned**, whose documented remedy
is that the CNAME target's owner must use Cloudflare for SaaS.

So routing for `kind: api` is a **platform-side** step — a custom hostname on
the platform's own zone, with the platform's own token — and a customer
credential has no authority over it. It is not implemented (§6).

**It can write records**, which is what this spec is:

| kind | what the credential writes | what remains |
| --- | --- | --- |
| `site` | the challenge TXT, and the CNAME to `target` (e.g. `you.github.io`) | GitHub's own certificate issuance (minutes to 24h), which nothing can hurry. `:provision` REFUSES a `site` domain with no `target` rather than writing the challenge alone and reporting success |
| `api` | the challenge TXT only | routing (§6) — deliberately unwritten, see below |
| `email` | — | not in v1 (`kind` is still `api\|site` in the dialect) |

**Why `api` gets no CNAME.** Writing one would produce a host that resolves
and then fails at TLS. A user cannot tell that apart from a slow rollout, so
they wait, then file a bug. Writing nothing is worse UX and better
engineering: the state stays honestly incomplete.

## 2. The records

`proxied` is explicit on every record, and the values are **measured, not
chosen** — verified against the live deployment:

| host | resolves to | proxy |
| --- | --- | --- |
| `saastarter2.saastemly.com` (site) | CNAME intact → GitHub's four Pages IPs | grey |
| `api.saastarter2.saastemly.com` (api) | Cloudflare anycast | orange |

A proxied record interferes with GitHub's certificate issuance for a custom
domain, so a `site` CNAME is written `proxied: false` and the caller is given
no say. A TXT cannot be proxied at all.

## 3. Additive only — the safety model

**v1 creates records and never modifies or deletes one.** Not "avoids
deleting"; has no code path that can. The provider interface exposes
`zones`, `list` and `create`, and nothing else.

This is a deliberate trade against a more capable design. Drift repair,
replacement and cleanup all need a rule for *which* record is ours, and the
obvious rule — a comment marker we stamp — is wrong: Cloudflare preserves
comments across dashboard edits, so a record the customer deliberately
re-pointed still carries our marker. A "repair" would then silently revert
the fix they made during an outage. Destructive authority can be added later
behind a server-issued, single-use confirmation bound to the observed record
state; it cannot be un-granted after the first accident.

Consequences, all tested:

1. A name holding a different record is a **conflict**: reported with what is
   in the way, and nothing is written. A customer's MX, SPF, apex or anything
   else is never collateral.
2. An already-correct record is **present**: no write, so re-running is free
   and safe. "Correct" includes the proxy flag — a record with the right value
   but the wrong flag is a CONFLICT, not a match, because a proxied Pages
   CNAME resolves and then fails certificate issuance, which is the exact
   breakage `proxied: false` exists to prevent.
3. The `?name=` filter is a request, not a guarantee — list results are
   **re-filtered in code**. A provider that silently ignored the parameter
   would otherwise return the whole zone and make every record look like a
   conflict at our name.
4. A plan containing a CNAME sharing a name with any other record is refused
   before it is sent. This is not hypothetical: it is the exact shape that
   makes an ACME TXT plus a DCV-delegation CNAME fail atomically, at 100% on
   the happy path.

## 4. The credential

Stored as the project secret `CLOUDFLARE_API_TOKEN` in the existing
write-only store (secrets.md §1) — no new storage, no new surface.

**Read through `projectSecrets`, never `projectEnv`.** The resolution ladder
in secrets.md §2 falls back to the worker environment, which is correct for a
SHARED capability (a project with no Stripe key uses the operator's gateway)
and exactly wrong for BYOK: a miss must mean "no account connected", never
"use ours". `CLOUDFLARE_API_TOKEN` is also among the likeliest names to
already exist in a deploy environment, so the collision is probable rather
than theoretical.

**Requested scope** — Zone → DNS → Edit, plus Zone → Zone → Read, scoped to
the specific zone. Two rows, nothing else.

**On scope verification, honestly.** Enumerating zones measures *inventory*,
not *policy*: a token scoped to "all zones in an account" that currently
holds one zone is indistinguishable from a correctly-scoped one, and every
additional zone-level permission is invisible. `GET /user/tokens/{id}`,
which would return the policy, is unreachable for a correctly-scoped token.
So v1 does **not** claim to verify scope. It asks for the minimum, documents
it, and treats every stored credential as more powerful than requested.
Users should set a token expiry.

## 5. The surface

`POST {BASE}/domains/{host}:provision`, owner-gated like every other method
on the resource.

```json
{ "dry_run": true }
```

Returns `{ applied, zone, created, plan[] }`, where each plan entry carries
`{action, type, name, content, proxied, detail?}`. `dry_run` computes the
plan and writes nothing — always available, because a plan that cannot be
inspected without side effects is not a plan.

Failure modes are RFC 9457 problems: no credential connected → 409 naming
the secret and the scope to set; credential covers no parent zone of the host
→ 409; provider refusal → 403 `PERMISSION_DENIED` for the
cannot-do-that family, 409 otherwise. **A token never appears in a problem,
a log, or a field on the resource.**

`target` (a new user field on `domain`) is where a `site` host points. It
exists because the Pages hostname is not derivable: `site` config is
free-form and carries a URL, not a repo owner.

## 6. Not built

- **`kind: api` routing.** Needs a custom hostname on the platform zone with
  the platform's token, its own DV wait, and a cost model. Until then `api`
  domains still route through the platform path or their existing custom
  domain.
- **Destructive operations** (§3).
- **Durable execution.** Everything here is a bounded, synchronous write; the
  moment a step waits on certificate issuance it needs a job and a resumer,
  and that is the boundary at which this design stops.
- **A second provider.** The seam exists (`DnsProvider`); only Cloudflare
  implements it.
- **Quota.** There is no per-project cap on domains and no rate limit
  anywhere in the codebase. This is acceptable only while provisioning
  spends the CUSTOMER's credential against their own zone — the moment a verb
  spends the PLATFORM's, a cap is a precondition, not a follow-up.

## 7. Conformance

1. `:provision` requires the project owner; anonymous is 401, a non-owner is
   403/404.
2. With no `CLOUDFLARE_API_TOKEN` the call is a 409 naming the secret.
3. `dry_run` writes nothing and returns the same plan the real call would
   act on.
4. Re-running is a no-op: everything `present`, zero writes.
5. A name holding a foreign record yields `conflict` and no write.
6. No code path issues DELETE, PUT or PATCH to the provider.
7. Every created record carries the project+host marker as its comment.
8. A credential never appears in any response, problem, or persisted field.
