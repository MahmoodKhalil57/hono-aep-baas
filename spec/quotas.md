# Rate Limits and Quotas

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/quotas`
**Status:** draft

## 1. Two mechanisms, one refusal shape

| mechanism | window | dimension | answers |
|---|---|---|---|
| **rate limit** | seconds–minutes | per key, per IP | "too fast" |
| **quota** | billing period | per project, entitlement-backed | "too much" |

Both refuse with 429 + RFC 9457 problem (`type` distinguishes
rate-limit from quota exhaustion) and both advertise state via the
IETF RateLimit header fields (draft-ietf-httpapi-ratelimit-headers:
`RateLimit`, `RateLimit-Policy`) so callers can back off without
parsing bodies.

## 2. Requirements

1. Rate limits are declared per key class with per-form overrides;
   enforcement is best-effort per-isolate first (Workers reality),
   durable counters only where the number is money (quotas).
2. Quotas are ENTITLEMENTS: the free tier is an entitlement granting N
   submissions/period (billing kind, entitlements-core) — quota
   enforcement lands on prepared ground when billing arrives, and
   until then a static default entitlement applies. The check runs at
   create; the counter increments only on accepted (non-`SPAM`)
   submissions.
3. Exhaustion behavior is declared per form: `reject` (429, default)
   or `park` (accept + hold undelivered — the submitter never sees the
   owner's billing problem; parked work delivers on quota renewal).
4. Headroom appears on the form's report card (forms.md §5) and in the
   RateLimit headers — never only in a dashboard.

## 3. Promotion path

This is an application spec, but rate-limiting is not baas-specific.
When a second application needs it, this file's §1–2 graduate to a
suite capability-service kind (`hono-aep-quotas` or a hono-aep core
concern) — recorded here so the future move is a promotion, not a
rewrite. Until then: TODO(baas) markers at the billing kind carry the
entitlement dependency.

## 4. References

- draft-ietf-httpapi-ratelimit-headers, RFC 9457
- billing kind (entitlements-core), baas/keys.md, baas/forms.md
