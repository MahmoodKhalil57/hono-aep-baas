# End-User Auth Pools

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/auth-pools`
**Status:** draft

## Abstract

A hosted app's users are NOT the baas's builders. saastarter makes the
phase-3 "per-project auth pools" row concrete: each project MAY declare
an auth pool — a better-auth instance scoped to that project, whose
users, sessions, and accounts are project instance data. The suite's
authn kind already runs multi-config; the pool is that kind, keyed by
project.

## 1. Requirements (the saastarter checklist)

1. Email + password with verification (send-on-signup), password reset,
   change-email confirmed at the NEW address.
2. OAuth providers per pool (client ids/secrets as EnvRefs on the pool
   config; provider enablement toggles the UI — env-presence, no flag
   system needed).
3. Passkeys (WebAuthn) and TOTP — the authn kind's existing config
   surface, per pool.
4. Sessions and accounts queryable as project data (owner-policied
   rows), because account dashboards need them.
5. Verified account deletion: two-phase (emailed token → confirm), with
   an **anonymize-instead-of-delete veto** — IMPLEMENTED: better-auth's
   deleteUser mails the token, and the `user.delete.before` database hook
   rewrites name/email to `deleted-<id8>@deleted.invalid` and returns
   false, vetoing the hard delete (the declarative-transition recast
   stays the roadmap; the veto behavior is live). Change-email
   (verification to the NEW address) is IMPLEMENTED too — both ride the
   sendEmail seam (§1.7).
6. Role arrays on pool users, checked by the same policy vocabulary
   (`role(...)`); the pool's "admin" role gates the project's generated
   admin surface.
7. Auth-lifecycle emails belong to the POOL (verification, reset,
   change-email, deletion) and ride the project's notifications
   instance for transport — templates overridable per project.
   IMPLEMENTED: verification + password-reset via a `sendEmail` seam
   the baas fills with `notifications.notify({to:{email},content})` —
   better-auth never learns about notifications; one delivery pipeline
   (jobs, providers, report cards). change-email + verified-delete are
   the remaining lifecycle flows.

8. **Anonymous principals (guest sessions)** — `POST
   sign-in/anonymous` mints a real bearer session for a user tagged
   `is_anonymous`; owner-scoped surfaces (carts, orders, wishlists —
   commerce.md §3a) work unchanged. Signing up/in while HOLDING the
   anonymous session fires the pool's `onLinkAccount` seam, and the
   platform re-parents the guest's rows to the new principal. Config
   knob `anonymous: {enabled}`; the seam is the baas's, so what gets
   re-parented is an application decision, not better-auth's.

### 1a. Static-origin sessions — IMPLEMENTED

Pool sessions work from cross-origin static frontends via BEARER tokens
(better-auth's bearer plugin; `set-auth-token` is CORS-exposed), because
the API's wildcard CORS deliberately excludes credentials — cookies are
the dashboard's transport, never the SPA's.

### 1b. The tenancy decision — DECIDED and IMPLEMENTED

Better-auth's email uniqueness is per table; the options were
per-project table sets (runtime DDL — against the JIT spirit), scoped
identities (leaks into delivered mail), or a tenancy seam. DECIDED: the
seam — ONE shared pool table set (composite `(project_id, email)`
uniqueness) behind a TENANCY-SCOPING ADAPTER: a per-project better-auth
instance whose adapter proxy tags `user` creates with the project and
filters `user` reads by it, transactions wrapped recursively. Defense
in depth: the pool principal ALSO verifies the user's tenancy tag, so a
foreign project's session token is a null principal even if a lookup
path bypasses the filter (it did, in testing — that is why both layers
exist). Pool enablement is the project's `auth_pool` config; the pool
principal joins the JIT apps' authorization chain after builder
sessions/keys, and the framework's owner auto-stamping records
`pool:{project}:{user}` on owner-bound creates.

## 2. What this is not

Not orgs/teams (saastarter has a single pool, no tenants — the §3a
multi-tenancy decisions stay deferred), and not the platform account
system (builders authenticate to the baas exactly as today).

## 3. Keys interplay

Pool users may mint their own scoped keys where the project enables it
(saastarter's developer tab): per-key rate limits, expiry windows,
metadata, and subset-delegated child keys — keys.md carries these as
extensions.

## 4. References

- suite authn kind (better-auth), notifications kind, baas/keys.md,
  baas/README.md §3 (phase 3), umbrella §3a (multi-tenancy)
- survey: saastarter `lib/auth/options.ts` (the checklist source)
