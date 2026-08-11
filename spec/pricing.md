# pricing.md — credits, not seats

Status: v1 draft (2026-08-11). Depends: kinds.md (the capability catalog is
the metering surface), parity.md §2.5 (ledger), secrets.md (BYOK), quotas.md.

## 0. The claim

| | Odoo | here |
| --- | --- | --- |
| unit | per user, per month | per operation |
| unlock | pay to unlock the app | buy credits to keep using capabilities |
| idle cost | full price whether used or not | **dormant costs nothing** |
| growth | a new user costs a seat | a new user costs what they consume |

> **Everything is billed, even a little.** A form submission, an order, an
> e-signature, an AI call — each has a published price. Nothing is free
> because nothing is free for us; and nothing has a floor, because our own
> substrate scales to zero.

The consequence that matters commercially: the **long tail becomes viable.**
A prototype, a seasonal shop, or a layer-3 builder with no customers yet
pays approximately nothing — which is what makes "sign up and build a
platform on top of us" an offer someone can accept before they have revenue.
A seat-priced product cannot make that offer.

## 1. Three classes of capability

The taxonomy the whole model rests on. Every entry in the catalog
(kinds.md §6) belongs to exactly one class, and its class determines who
holds the key, who pays the vendor, and what we charge.

| class | key held by | vendor paid by | we charge |
| --- | --- | --- | --- |
| **BYOK** — Stripe, GitHub, Google OAuth | the customer | the customer, directly | nothing for usage |
| **Metered pass-through** — AI (catalogued); Mapbox and other vendor APIs are `spec-first` until catalogued | us | us | vendor cost + the published markup (§3) |
| **Native** — form submission, order, domain verify, search | us | — (our own substrate) | a published credit price |

`e-sign` was priced here before it existed; it is not in the catalog
(kinds.md §6) and `media` is storage-only (parity.md §1). An unpriced,
uncatalogued capability cannot be billed — see §8.1.

### 1.1 Why Stripe MUST be BYOK — and it is not a preference

If customer funds flowed through our account we would be a payment
facilitator: money-transmission licensing, KYC/AML obligations, settlement
risk, and chargeback liability for other people's businesses. **BYOK keeps
funds moving merchant ↔ buyer directly**, and keeps us a software vendor.

The same logic makes GitHub BYOK: the repo, the Pages deploy, and the
account limits are the customer's, so there is nothing for us to resell and
no lock-in to defend.

BYOK also sets an honest boundary on support: we can be responsible for a
capability we host, not for a vendor account we cannot see.

## 2. Credits

- A **credit** is a fixed, published fraction of a currency unit. It must be
  small enough that a single form submission has a sensible integer price.
- **Top-up** buys credits at list price. **Packs** (a subscription) buy them
  cheaper per credit — that is the only discount mechanism, so pricing stays
  one axis.
- A pack MAY be **free and recurring**: that is how quotas.md's free tier is
  expressed — an entitlement that mints N credits per period rather than a
  separate allowance mechanism. "Everything is billed" means every operation
  has a *price*, not that every operation is *paid for* by the customer.
- Balance is a **fold over an append-only usage ledger**, never a mutable
  counter. Credits are money: a balance that can drift is a refund dispute.
  (This is **`balances.md`** Profile A — see parity.md §2.5 for the reframing — append-only entries
  parameterised by unit. Credits are Profile B, which parity.md §5 ships
  first precisely because this document requires it.)
- Every charge is traceable to the operation that caused it, and appears on
  a receipt the customer can audit.

### 2.1 Zero balance suspends; it never destroys

At zero, capabilities stop; **data does not**. A store that runs out of
credits keeps its catalog, orders, and domain, and resumes on top-up. Any
other behaviour turns a billing event into a business-ending one, and would
make the model unsafe to build a livelihood on.

Reads SHOULD degrade last: a shop that cannot take an order should still
render, so the operator sees why.

## 3. One markup, published

> The service fee is a **single published multiplier applied identically to
> every metered pass-through capability.**

Not per-service pricing, not a spread we decline to explain. The receipt
shows vendor cost and fee separately, so a customer can verify the number
against the vendor's own price list.

### 3a. Rounding, and why "exact" needs a clause

Vendor billing is not continuous, so an exact multiplier over a rounded
input is still a misprice. The published fee MUST state its rounding:

- **R2 rounds usage UP** to the next million operations / next GB-month —
  1,000,001 Class A operations bill as 2 million.
- **Queues** bill per 64 KB chunk, so a 127 KB message costs double.
- **Vectorize** bills `(stored + queried) × dimensions` — every query pays
  for the whole index.
- **Durable Objects** bill duration at a flat 128 MB while resident, not
  only while executing, and WebSocket messages at 20:1.

So a minimum billable unit is published per capability alongside the
markup. Without this, small tenants are systematically under-billed and
the "exact consistent markup" promise quietly breaks.

This is a trust property, and it is also a constraint on us: we cannot hide
margin in an expensive capability, so we are pushed toward capabilities that
are genuinely cheap to run — which is the same pressure that produced
parity.md §2.7's "bind cheap Cloudflare products, exclude Stream".

## 4. Metering must cost less than it earns

The honest engineering constraint. A form submission priced at a fraction of
a cent **cannot afford a D1 write, a Stripe call, or a synchronous ledger
append** per event.

1. Every capability invocation already crosses a known seam (kinds.md §8);
   that seam is the meter.
2. Usage is written on the **cheap path** — Analytics Engine or Pipelines
   (parity.md §2.7), not a row per event in D1. Note that **D1 already
   returns `meta.rows_read` / `meta.rows_written` on every query**, so the
   per-tenant meter for storage-backed capabilities needs no new infra.
3. The credits ledger is settled **periodically** from aggregated usage, not
   per operation.
4. Metering failure MUST fail open for the customer and be reconciled later.
   Refusing service because we could not bill is worse than under-billing.

## 5. Recursive billing

Layers bill their own customers; we bill the layer. Same fold as the
narrowing law (kinds.md §3):

- bastarter's customers hold balances **with bastarter**, not with us.
- bastarter holds a balance with us, and its consumption is the sum of its
  own plus its children's.
- A layer sets **its own markup** on top of ours — that is its business
  model, and it is why reselling is worth doing.
- We never bill a layer's customers directly: no contractual relationship,
  and inserting ourselves would undercut the layer we are selling to.

Attenuation applies to money as it does to capability: a layer cannot sell
what it does not hold, so a customer's bill is always bounded by what its
parent actually bought.

## 6. What "dormant costs nothing" honestly promises

Compute scales to zero — Workers, D1 reads, cron — so an idle project has no
request cost. **Storage does not scale to zero.** Bytes in D1 and R2 accrue
whether or not anyone visits.

So the promise is precise: **no idle fee, no seat fee, no minimum** — and
storage is either absorbed below a published threshold or billed at cost
with the §3 markup. Stating this is the difference between a promise and a
future dispute.

## 7. Migration from entitlements

Today's `hono-aep-billing` is `entitlementGrant` + `billingCustomer` —
grants that unlock features, which is the seat/unlock shape this document
replaces. Entitlements do not disappear; they are re-aimed:

- **Packs** grant N credits per period (an entitlement that mints credits).
- Feature-flag-style grants remain useful for capability *access*, while
  credits govern capability *consumption*.

## 7a. x402 — the agent-facing settlement layer (PLANNED)

Cloudflare's **x402** is an HTTP-402 primitive for charging **per MCP tool
call**, which is this document's per-operation model at the agent boundary.

It is recorded, not adopted: the credits ledger (§2) must exist regardless —
it governs native and pass-through capabilities, human and agent traffic
alike — and two settlement paths before one ledger works would be a
reconciliation problem, not a feature. Once Profile B lands, x402 is the
likely way an agent settles without holding an account with us.

Noted here so the metering seam is designed for it rather than retrofitted,
the same treatment `kinds.md` §8 gives the capability meter.

### 7b. Price the paywall, not the plumbing

The Odoo audit (parity.md §0a) is direct pricing evidence: the incumbent
gives away data models and invariant engines and charges for **aggregation,
automation, approval, time, and document artifacts**. Those are exactly where
our credit prices should be non-trivial — and conversely, pricing a form
submission aggressively while giving away an aggregation query would invert
the one pricing signal the market has already validated.

## 8. Conformance

1. Every billable operation has a **published price before it can be
   charged**. An unpriced capability is free by definition.
2. Every charge is traceable to an operation and appears on a receipt.
3. The markup is one published number, applied identically (§3).
4. Zero balance suspends capabilities and preserves data (§2.1).
5. BYOK capabilities never bill for vendor usage (§1).
6. A dormant project accrues no request charges (§6).
7. Metering failure never denies service (§4.4).
