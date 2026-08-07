# Counters

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/counters`
**Status:** draft

The second primitive (phase 2), same founding constraint as forms:
usable from static HTML. View counters, like buttons, RSVP tallies —
the classic "I just want a number on my page" backend.

## 1. Model

```
projects/{project}/counters/{counter}
```

An owner-defined counter with a public `:increment` custom method
(AIP-136) and a public read of the value — the write is anonymous, the
configuration is not:

- `<img src="…/counters/{id}/badge.svg">` — zero-JS read (an SVG badge,
  the hit-counter tradition done properly: ETag'd, cacheable seconds).
- `POST …/counters/{id}:increment` from a form or fetch with the
  project's `pk_` key; `GET …/counters/{id}` returns `{value}`.

## 2. Requirements

1. Increments are commutative and idempotent per AEP-155 `request_id`
   when supplied; anonymous double-fire is mitigated by the same
   content-hash window as forms (here: IP+counter, short window).
2. Abuse posture reuses forms.md §2 layers (honeypot n/a; challenge
   optional; allowlist + rate limits apply) — one spam model, not two.
3. Exact counts up to a declared cardinality; owners MAY opt into
   `approximate: true` for high-traffic counters (implementation may
   then use probabilistic sketches; the contract exposes the same
   `{value}` with an `approximate` flag — never a different API).
4. `counters.{id}.increment` events flow through aep/events like every
   other verb (a digest email of yesterday's counts is a cron job entry,
   not a feature).

## 3. References

- AIP-136, AEP-155, aep/events, baas/forms.md §2, baas/quotas.md
