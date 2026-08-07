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
   an app-declared **anonymize-instead-of-delete veto** — deletion
   becomes a transition (`delete-requested → anonymized`) so the veto
   is declarative, not a hook.
6. Role arrays on pool users, checked by the same policy vocabulary
   (`role(...)`); the pool's "admin" role gates the project's generated
   admin surface.
7. Auth-lifecycle emails belong to the POOL (verification, reset,
   change-email, deletion) and ride the project's notifications
   instance for transport — templates overridable per project.

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
