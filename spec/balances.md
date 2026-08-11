# balances.md — append-only entries, parameterised by unit

Status: v1 draft (2026-08-11). Depends: parity.md §2.5 (the reframing and the
evidence), pricing.md §2 (credits are Profile B), collections.md (the data
plane), kinds.md §1 (why this is a platform capability, not a document).

## 0. The claim

A balance is not a number you update. It is a **fold over entries you only
ever append**:

> **Append-only signed entries + balance-as-a-fold + sufficiency checked at
> write time + immutable once posted — parameterised by UNIT.**

The reframing is the point. Specified as "double-entry accounting" this is a
one-app unlock and the largest, riskiest thing on the roadmap. Specified as
above, **one build serves roughly a third of the Odoo catalog** (parity.md
§2.5, 19/34), because these are all the same shape with a different unit:

| what | unit | why it is a balance |
| --- | --- | --- |
| platform credits | credits | pricing.md §2 already requires exactly this |
| stock on hand | quantity × location | `stock.move` **is** double-entry with locations as accounts; quants are the materialised fold |
| leave entitlement | days | allocations credit, requests debit, and an overdraw must be refused |
| forum karma, quiz score, course progress, referral points, gift cards, prepaid SMS | points | a running total nobody may edit directly |

**Why a platform capability and not a collection.** A collection with an
`amount` field cannot enforce that the total never disagrees with its
history, that a posted entry is never edited, or that a write is refused for
insufficiency. Those are invariants (kinds.md §1: new behavior is a platform
change, not a document). A beginner must not be able to misconfigure a
balance into disagreeing with itself.

## 1. The model

A **ledger** is a named balance space; an **entry** is an immutable signed
movement within it.

`{BASE}/ledgers/{ledger}` — the definition (definition plane):

| field | meaning |
| --- | --- |
| `unit` | REQUIRED. `credits`, `points`, `days`, `qty`, or an ISO-4217 currency |
| `profile` | `single` (A: §3) \| `double` (B: §4) \| `positional` (C: §5) |
| `scale` | integer minor units per whole unit (`100` for cents, `1` for points). Amounts are **integers**; floats are refused |
| `allow_negative` | default `false` — a write that would overdraw is refused (§2.3) |
| `holders` | what a balance is keyed by (a principal, a location, an account) |

`{BASE}/ledgers/{ledger}/entries/{id}` — the data plane:

| field | meaning |
| --- | --- |
| `holder` | whose balance moves |
| `amount` | signed integer in minor units |
| `reason` | a closed vocabulary per ledger (`topup`, `usage`, `refund`, `allocation`) |
| `ref` | the operation that caused it — an idempotency key AND the audit link |
| `posted_time` | output-only; set on post |
| `prev_hash` | output-only; §6 |

## 2. Rules

### 2.1 Append-only

Entries have **no update and no delete**. A correction is a **compensating
entry** carrying `ref` to the entry it reverses. This is not a style
preference: an editable history means the balance and its explanation can
disagree, and every downstream dispute becomes unanswerable.

Soft-delete is not offered here — a hidden entry is an edited history.

### 2.2 Balance is derived, never stored authoritatively

`balance(holder) = Σ entries.amount`. A materialised total MAY exist as a
cache (it must, at scale — see §7), but it is **derived state**: it is
recomputed from entries, never written to directly, and any disagreement is
resolved in favour of the entries.

### 2.3 Sufficiency is checked at write time

Where `allow_negative` is false, posting an entry that would take a holder
below zero is **refused** — an RFC 9457 problem, not a silent clamp and not
an after-the-fact alert. This single rule is what makes the primitive serve
leave requests (`hr_holidays` refuses an overdraw), prepaid credits, and
stock reservations rather than only accounting.

### 2.4 Idempotency

`ref` is unique per ledger. Re-posting the same `ref` returns the original
entry rather than creating a second (AEP-155). A meter that retries — and
pricing.md §4.4 requires metering to fail open and reconcile later —
therefore cannot double-charge.

## 3. Profile A — single-unit (ship first)

One unit, one holder per entry, sufficiency at write. That is the whole
profile, and it is what **credits** need, which is why it ships first:
`pricing.md` §2 already commits to it.

The same profile immediately delivers karma, quiz scores, course progress,
referral points, gift-card balances and prepaid SMS — none of which need
anything below.

## 4. Profile B — double-entry

Adds: an entry names **two** holders (accounts), and the sum of every
movement in a transaction is **zero**. Plus period locking (entries before a
closed date are refused) and a currency unit.

Double-entry is therefore *a constraint added to Profile A*, not a different
mechanism. Odoo's `account` — full double-entry with a database-level check
keeping debits and credits equal — is **LGPL-3 and readable**; this is not
novel research, and parity.md's earlier risk estimate was too pessimistic.

Tax engines, fiscal position rules and valuation methods (FIFO/AVCO) are
**not** in this profile: they are jurisdiction- and policy-specific and stay
separate platform capabilities (parity.md §2.5's boundary).

## 5. Profile C — positional (stock)

Adds: the holder is a **location**, and a movement debits one location while
crediting another — the same zero-sum rule as Profile B with locations in
place of accounts. On-hand quantity is the fold; a **reservation** is an
entry against a pending position, which is what makes double-selling
structurally impossible rather than merely unlikely.

Concurrency: a reservation must be serialised per SKU-location. That is a
Durable Object (parity.md §2.7's three-for-one bind), not a transaction
retry loop.

## 6. Audit trail (fold it in here)

Each entry carries `prev_hash` = a hash of the previous entry in its ledger
plus its own content. Tampering with any historical entry invalidates every
subsequent hash, so the chain is verifiable without a second log.

This is a column, not a subsystem — which is exactly why it belongs here
rather than in a separate audit capability. Several domains need it for
**legal** rather than diagnostic reasons, and the platform's wide events
(observability) answer a different question: who called what, not what the
balance was.

## 7. Cost and scale

Balances are read far more than written, and `Σ` over all history is not a
per-request query.

1. A **materialised balance** per holder is maintained alongside the entries
   and is authoritative-for-reads, entries-authoritative-for-truth (§2.2).
2. Recompute-from-entries MUST exist as an operation, because a cache that
   cannot be rebuilt is a second source of truth.
3. Metering writes ride the cheap path (pricing.md §4); the ledger settles
   **periodically** from aggregated usage rather than one entry per metered
   operation. A sub-cent form submission cannot afford its own entry.

## 8. Conformance

1. No update, no delete on entries; corrections are compensating entries.
2. `balance` always equals the fold of its entries; a materialised total that
   disagrees is a bug, and rebuild is available.
3. A write that would overdraw a `allow_negative: false` ledger is refused
   before it is stored.
4. The same `ref` never produces two entries.
5. Amounts are integers in declared minor units; a float is refused.
6. `prev_hash` chains and verifies over a ledger's full history.
7. Profile A works with no knowledge of accounts, locations or currency.

## 9. Non-goals v1

- **Tax, valuation methods, fiscal periods** — separate platform
  capabilities (§4).
- **Multi-currency conversion.** A ledger has ONE unit; FX between ledgers is
  an application concern, and a rate stored inside a balance would make the
  fold non-deterministic.
- **A general journal UI.** The studio renders ledgers like any other
  definition-plane resource; an accountant's workbench is an application.
- **Cross-ledger transactions.** Atomicity is per ledger; a flow spanning two
  ledgers composes through jobs with idempotency (`ref`), as every other
  cross-store flow in the suite does.
