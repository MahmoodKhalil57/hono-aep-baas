# parity.md — Odoo as the capability yardstick

Status: v1 draft (2026-08-11). Depends: kinds.md (the capability catalog),
collections.md, commerce.md, services.md, seed.md.

## 0. Why Odoo, and what "parity" may not mean

Odoo is a well-tested taxonomy of what a business actually needs, validated
by enormous adoption. Measuring against it replaces "what could we build?"
with "what does a business need?" — a much better question, and the reason
this document exists.

But **literal parity is not a milestone.** Odoo is an ERP of ~50 official
apps and thousands of community modules, built over fifteen years. Adopting
"parity" as a goal would trade a clear vision for an unreachable one.

The useful reading, and the thesis of this document:

> Odoo's app catalog is a **checklist for capabilities**, not a backlog of
> apps. Most Odoo apps are a data model plus a workflow — shapes our JIT
> collections already express. The gap is a small number of missing
> PRIMITIVES, and each one unlocks many apps at once.

### 0a. What Odoo actually charges for

Decomposing the 11 Enterprise-only apps to primitives, **not one owns a
ledger, a transactional data model, or a document type of its own.** Every
one reduces to a combination of aggregation, automation, approval, time, and
document artifacts:

> **Odoo gives away the data models and the invariant engines, and charges
> for AGGREGATION, AUTOMATION, APPROVAL, TIME, and DOCUMENT ARTIFACTS.**

Three consequences a competitor must internalise:

1. **The ledger is free.** `account` — full double-entry, with a DB-level
   check keeping entries balanced — is LGPL-3 and readable. Odoo does not
   monetise it. §2.5's risk estimate was too pessimistic.
2. **Aggregation is the revenue line**, not a reporting nicety. Confirmed
   twice independently: `account` free / `account_reports` paid; Fleet's data
   model free / the pivot cost analysis *is* the product.
3. **"We are the free one" is not an available position.** Community is far
   deeper than the comparison pages admit — stock valuation, competing-vendor
   tenders, subcontracting, gamification, forum, live chat, the whole
   Websites category and the hospitality vertical are all free. The available
   positions are **setup cost, pricing model, and recursion** — never
   price-of-software.

The product goal is **Odoo's breadth at saastarter2's setup cost**: an
Odoo app is installed and configured; the equivalent here should be a
config file a beginner can read. Anything that cannot be delivered that way
does not belong in the catalog yet.

## 1. What the catalog already covers

| Odoo app | our capability | state |
| --- | --- | --- |
| Website Builder | `page`, `block`, `theme` | ✅ |
| eCommerce | `collection` + commerce.md, `gateway`, `delivery` | ◐ — no pricelists, no per-line reporting (embedded `items[]`), tax carried not calculated, and the webhook blocker in production.md §E |
| Blog / Knowledge | `collection`, `page` | ✅ generic |
| Surveys / Helpdesk intake | `form`, `submission` | ✅ |
| Projects & Tasks | `collection` + states/transitions | ◐ generic — needs §2.1 relations and §2.9 mixins to feel like one product |
| Subscriptions (entitlements) | `billing` | ◐ grants, not dunning |
| Email (transactional) | `notifications` | ◐ transactional, not campaigns |
| Documents | `media` | ◐ storage, no versioning/sign |
| Discuss | — | ✗ |

The "generic ✅" rows matter: a CRM pipeline, a task board, and a recruiting
funnel are all *a collection with states and transitions*. We do not need a
CRM module; we need collections to stay expressive.

## 2. The primitives that are actually missing

Each unlocks a family of Odoo apps. This is the real roadmap.

### 2.1 Relations — the highest frequency (32/34)

`reference` and `references` exist as field types carrying
`{resource, collection, titleField}`, so a target and cardinality can be
*declared* — but see §3: the hosted `collection-config` field enum does not
expose them, so a builder cannot actually write one. The flagship proves it:
`saastarter2` declares `reviews.product` and `wishlist.product` as **plain
strings**.

Four parts, and the earlier draft named only the first:

- **2.1a Integrity** — reverse accessors (a customer listing its orders
  without a hand-written filter), write-time referential integrity, and
  **cascade / restrict / SET NULL**. Set-null matters: archiving an employee
  *nulls* manager pointers; a naive cascade would delete the org chart.
- **2.1b Through-rows** — an edge WITH attributes. Course completion lives on
  the `(member, content)` edge; a forum vote is a composite-unique
  `(user, post)`; a mailing opt-out lives on the list↔contact edge. A
  `reference` declares a *pointer*, never an edge that carries data.
- **2.1c Recursive traversal** — with cycle detection and a depth bound
  (BOM explosion, org-chart transitive closure, category roll-up).
- **2.1d Stored computed fields** — moved to its own §2.8; it is a separate
  primitive, not a facet of relations.

### 2.2 Automation — three trigger classes, not one (23/34)

"When a sale order is confirmed, create an invoice." The substrate exists
(events + a jobs queue); what is missing is a rule a beginner can read.

**The earlier framing — "event → action" — expresses about a third of the
demand.** The shape the evidence requires is:

> **(predicate over a record set, optional measure/target, action)
> × {event, schedule, threshold}**

- **event** — the case we had.
- **schedule** — Odoo's own reusable implementation, `gamification`, is
  **(domain filter, measure, target, reward) evaluated on cron**. It is
  Community, ~15 years old, and depends only on `mail`: a free reference
  implementation of exactly this primitive.
- **threshold** — a measure crossing a target, which is the same evaluation
  on a different trigger.

Plus one trigger class that is easy to miss and load-bearing:
**absence-with-timeout.** `marketing_automation` branches on *negative*
outcomes (`mail_not_open`) that fire only when a timeout expires and are
**cancelled** by an inbound event. A rule engine without it cannot express
"chase the customer who did not reply".

Actions are a **closed vocabulary** (create/update/transition/notify/enqueue),
never expressions — that is what keeps this a primitive rather than a
programming language, and it is why automation is a **separate primitive and
not a binding** (suite law 7 stands unamended: bindings configure, they never
compute).

Unlocks: Marketing Automation, Approvals, Helpdesk SLAs, `quality`'s injected
checks, `documents`' folder rules — and two Enterprise apps reduce to this
plus §2.6.

### 2.3 Aggregation — the widest unlock, and Odoo's paywall (29/34)

Odoo ships pivot/graph views over every model. We have list/get with filters
and **no aggregation at all** — no `sum`, `group by`, or measure.

Scope, which the earlier draft under-stated:

- hierarchical group-by with **computed subtotals**
- **drill-back** from an aggregate to the source rows (`account_reports`)
- **empty-group expansion** — render every stage column *including
  zero-count ones*, i.e. aggregate against a full domain axis rather than
  the rows present (`hr_recruitment`'s kanban)
- **time-bucketed** roll-ups (`stock` forecasting)

**Correction to the "BIND Analytics Engine" framing:** AE is right for
write-heavy metering (`pricing.md` §4) and **wrong** for record-scoped
rollups that must agree with the rows — course progress, order totals,
karma. Those are a D1 `GROUP BY`. So this is **BIND AE + BUILD a D1
group-by API**, not one or the other.

> **This is the revenue line.** Odoo gives away `account` (the double-entry
> engine) and charges for `account_reports`. It gives away Fleet's data model
> and the pivot cost analysis *is* the product. Aggregation is not a
> dashboard nicety — it is what the incumbent monetises, which makes it both
> the widest unlock and the place our own credit prices should be non-trivial.

### 2.4 Sequences — real, but over-ranked (11/34)

Gap-free formatted document numbering (`INV/2026/0042`). `counters.md` is
adjacent but is a public metric counter, not a transactional sequence.

**Demoted from #3 in §5.** It is a Finance + Supply-Chain primitive:
**zero** HR apps need a document number, zero Websites apps, zero Marketing
apps. It is small and self-contained, so it stays cheap — it simply does not
unlock breadth the way §2.1–2.3 do.

### 2.5 Balances — append-only, parameterised by UNIT (19/34)

**This section was mis-framed as "Ledger" and it cost us the roadmap.** Framed
as double-entry accounting it is a one-app unlock and the largest, riskiest
build. Framed correctly it is one primitive serving a third of the catalog:

> **Append-only signed entries + balance-as-a-fold + sufficiency checked at
> write time + immutable once posted — parameterised by UNIT.**

One build then serves, with the unit as the only variable:

| profile | unit | entries | proof |
| --- | --- | --- | --- |
| **B — single-unit** (ship first) | credits, karma, points, quiz score, progress, SMS credits | signed deltas | `pricing.md` §2 **already requires it** for credits |
| **A — double-entry** | currency + account pair | debit/credit, period locking | `account` (Odoo) |
| **C — stock** | quantity + location | `stock.move` **is** double-entry with **locations as accounts**; quants are the materialised fold | `stock` |

Leave days are the same shape again: `hr.leave.allocation` credits netted
against `hr.leave` debits, with a write-time sufficiency check refusing an
overdraw. Three independent category audits (Finance, Websites, HR) reached
this generalisation separately.

Two corrections to the old framing:

1. **Ship Profile B first**, not last. `pricing.md` §2 already commits to
   "balance is a fold over an append-only usage ledger, never a mutable
   counter" — the credits ledger *is* this primitive, and the same build
   immediately delivers forum karma, course progress, referral points and
   leave balances.
2. **The risk estimate was too pessimistic.** Odoo's `account` is LGPL-3 and
   readable, including the DB-level `CHECK` that keeps entries balanced. A
   reference implementation exists; this is not novel research.

Fold the **hash-chained audit trail** in here rather than building it
separately — it is a `prev_hash` column on the entry, and several domains
need it for legal rather than diagnostic reasons.

> **The boundary still stands.** A *balance* is generic. **Tax engines,
> stock valuation methods (FIFO/AVCO) and fiscal period rules are not** —
> they carry jurisdiction- and policy-specific invariants and remain
> PLATFORM capabilities (kinds.md §1). Pretending otherwise is how a CMS
> becomes a bad ERP.

### 2.6 One policy expression, four positions (14/34)

`TransitionDefinition` carries `from`, `to`, `description`, `after` — and
**no policy**. Policies bind only at the METHOD surface, so today "anyone who
may call the resource may fire any transition it permits", and a two-step
approval is inexpressible.

Widened in three ways the earlier draft missed:

1. **The policy must read the RECORD**, not just the caller — "orders above a
   monetary threshold require a manager".
2. **It must read DERIVED values** — "karma ≥ 30 to upvote" is a threshold on
   a computed fold, not a role.
3. **The same expression is needed at FIELD granularity** — which is also the
   fail-open PII gap recorded in `collections.md` §3a. One expression
   evaluated at four positions (method, transition, field, row) rather than
   four mechanisms.

#### 2.6b The `before` veto — the cheapest item in the audit

Distinct from *who may fire it*: **may this transition fire at all?**
`quality`'s blocking check, a purchase three-way match, and a leave-balance
sufficiency refusal are all vetoes, not authorizations. Purely additive to an
existing type, roughly a day's work, and it unlocks disproportionately.

## 2.7 The substrate: what we can bind cheaply

We bind **three** products today — D1, R2, Workers AI — plus a 1-minute
cron. Everything else in the catalog is unused, and the §2 gaps map almost
one-to-one onto products that are a binding away:

| gap (§2) | product | why it fits | cost |
| --- | --- | --- | --- |
| 2.3 aggregation | **Analytics Engine** | write-heavy time series + SQL read API; reporting without a new data model | very low |
| 2.4 sequences | **Durable Objects** | single-threaded per object ⇒ gap-free numbering is its natural shape | low |
| 2.2 automation | **Workflows** | durable multi-step execution with retries — exactly "confirm order → invoice" | low |
| jobs (today cron-polled) | **Queues** | real async delivery instead of a minute-granularity poll | low |
| forms challenge (forms.md §2) | **Turnstile** | the PLANNED captcha binding, already spec'd | **free** |
| inbound intake | **Email Routing** | email → Worker ⇒ a ticket/submission, no mailbox to run | **free** |
| search | **Vectorize** | we already embed with Workers AI; this stores the vectors | low |
| quotas.md | **Rate Limiting** | the declared quota surface, enforced at the edge | included |
| config/cache | **Workers KV** | cheap read-heavy cache in front of D1 | low |
| AI spend control | **AI Gateway** | caches and meters model calls | free/low |

Metered but justified **per use**, never by default:

- **Images** — media transforms. Cheaper than shipping originals, but it is
  billed; bind it behind a per-project opt-in.
- **Browser Rendering** — PDF invoices and OG snapshots. Real value for
  finance, real cost per render; use it for artifacts, never per request.

### The tenancy ceilings (measured, and no other spec states them)

The single most useful table for anyone designing on this platform, because
it decides what "per-tenant" can mean:

| resource | cap | per-tenant viable? |
| --- | --- | --- |
| **D1 databases** | 50,000 (raisable to millions), **10 GB each** | **yes** — and Cloudflare's own docs endorse per-tenant databases |
| **R2 buckets** | 1,000,000 | **yes** |
| **KV namespaces** | **1,000** | **no** — key-prefix instead |
| **Workers scripts** | **500** | **no** — this is the wall that Workers for Platforms exists to sell past |
| DO objects | unlimited, 10 GB each, **~500–1,000 req/s each** | yes, but shard by throughput |
| Queues | 10,000 queues, 5,000 msg/s each | yes — and per-queue metrics give clean per-tenant attribution |

### Backup is already solved, and no spec said so

**D1 Time Travel is always-on, free, and gives 30-day point-in-time
recovery per database**; DO SQLite has its own 30-day PITR. `production.md`
listed "no backup/restore" as a blocker. The real remaining gaps are much
narrower: **restore drills** (a backup nobody has restored is a hope) and
**>30-day retention** (export D1 → R2).

### Corrections to the earlier bind table

- **`jobs` → Queues is only a partial replacement.** Queues are
  at-least-once with **no ordering**, a **24 h max delay**, and **no
  per-message cancel or query**. "Cancel job 123" and "pending jobs for
  tenant X" still need a job table — or **DO alarms**, which are per-entity,
  inspectable and cancellable (at-least-once, max 6 retries, 15-min handler).
- **The DO bind is three-for-one.** It was earmarked for sequences (11/34)
  alone. The same binding delivers **concurrency-safe reservation**
  (single-threaded per object ⇒ double-booking is structurally impossible)
  and **hibernatable WebSockets** (near-free idle). One bind, three gaps.
- **`search` → Vectorize carries a cost trap**: it bills
  `(stored + queried) × dimensions`, so **every query pays for the whole
  index**. Per-tenant vector search needs namespaces and a cost model, not
  just a binding.

### Products no spec knew about

From the official SDK (118 products): **`email-sending`**, **`pipelines`**
(ingestion → R2 — the cheap write path for usage metering),
**`aisearch`** (managed RAG), **`custom-hostnames`** (this is Cloudflare for
SaaS, the BYO-domain path `domains.md` §5 names), **`alerting`** (which
`production.md` lists as a missing capability — it is a binding),
**`secrets-store`**, **`workflows`**, **`rate-limits`**,
**`browser-rendering`**, **`images`**.

### Deliberately excluded — with one correction

- **Stream** — video. The expensive class, and avoidable: R2 stores bytes
  egress-free and a third-party embed costs nothing.
- **Realtime / Calls (SFU)** — media routing, genuinely expensive.
  **Correction:** the earlier blanket "realtime" exclusion was too broad.
  **Text and presence** — chat, live inboxes, collaborative cursors — ride
  **DO hibernatable WebSockets** at near-zero idle cost and are firmly in
  scope. Only *media* SFU is excluded.
- **Containers / Sandboxes** — heavier compute than a Worker for problems a
  Worker solves.
- **Hyperdrive** — pooling for external databases we do not have (and it caps
  at 25 configs, so it is not a per-tenant story either).
- **Pages** — the consumer frontends already ship on GitHub Pages.

Also split rather than excluded: **PDF**. *Rendering* is Browser Rendering
(metered, use for artifacts); *manipulating* an existing PDF (the e-signature
case) is a WASM library in the Worker, and costs nothing extra.

### Workers for Platforms — the one we route around

Cloudflare's own answer to multi-tenant white-label is dispatch namespaces,
and it is **enterprise-priced**. Our nested projects and narrowing law
(surface.md §1, kinds.md §3) reach the same product on the standard plan,
because tenancy is expressed as *routing plus a capability fold* rather than
as isolated scripts. Worth stating explicitly: it is a cost moat, and it is
why "layer 3 needs no Cloudflare account" is affordable to offer.

The sequencing in §5 barely changes as a result — but three of its five
steps stop being "build a primitive" and become "bind a product", which is a
materially smaller job.

### 2.8 Stored computed fields on a dependency graph (14/34)

Not aggregation. **Aggregation answers reports; computed fields keep ROWS
correct.** An order line's subtotal, a purchase order's total, a vehicle's
next-service date, a task's remaining hours — each is derived, stored, and
must be recomputed when a dependency changes.

Needs a declared dependency graph (`depends: [lines.price, lines.qty]`),
recompute-on-write, and a defined ordering so a field never reads a stale
sibling. Without it a consumer computes totals client-side and they drift —
which is exactly what `commerce.md`'s embedded `items[]` does today.

### 2.9 Composable record mixins (14/34)

`mail` appears in ~15 Odoo manifests. Its mixins are what make the apps feel
like one product: **chatter** (per-record message thread), **followers**
(per-record subscription), **activities** (assigned to-dos with due dates),
plus ratings and a publish gate.

The point is composability: a mixin is declared ON a resource and brings its
own storage, UI slot, and policy surface. We have `notifications` (a delivery
pipeline) but nothing that attaches a thread, a follower set, or an activity
to an arbitrary record. This is what "a CRM pipeline is just a collection
with states" quietly assumes and does not supply.

### 2.10 Time-triggered transitions (12/34)

"The state changed because a date passed." A subscription renews, an
appraisal falls due, a booking expires, a vehicle's service comes round.

Distinct from §2.2's schedule trigger by intent: it is a property OF the
resource's lifecycle rather than a rule written about it, so it belongs on
the transition (`after: <date field> + <interval>`). A small rider on §2.6's
`TransitionDefinition` change plus §2.2's scheduler.

> **Scope caveat on the frequencies above.** The audit covered 34 of 44 apps;
> Services (Project, Timesheets, Field Service, Helpdesk, Planning,
> Appointments) and Productivity (Discuss, Approvals, Knowledge, IoT) were
> not classified. Two further primitives — **temporal booking** and
> **resource calendars** — concentrate in exactly those categories, so their
> demand is *systematically understated* here rather than absent.

## 3. What this implies for `/v1/schemas/`

The schema surface is the beginner-facing contract, and it currently lags:
**10 kinds published against 18 capabilities.** Every capability a project
can bind SHOULD have a published, `$schema`-linked config shape, so a
builder discovers a capability by reading a file rather than by reading us.

1. `/v1/schemas/` MUST serve an **index** of every published kind. It 404s
   today, so the surface is undiscoverable without prior knowledge.
2. Capabilities without a config schema — `media`, `search`, `jobs`,
   `notifications`, `billing`, `gateway`, `delivery`, `connections`,
   `flags`, `domain`, `kind` — SHOULD each publish one.
3. New primitives (§2) ship WITH their schema, never after.

## 4. How breadth stays cheap (the saastarter2 clause)

Odoo's cost is that installing an app reshapes the whole system. The
capability model avoids that by construction: a project binds only what it
declares (kinds.md), so breadth in the catalog costs a store nothing.

- saastarter2 binds ~5 capabilities; its config stays the size it is today.
- An ERP-shaped consumer binds 30; its config is larger *because its product
  is larger* — the §2b invariant, working as intended.

So the recursion work is not superseded by this pivot: **kinds is the
delivery mechanism that lets the catalog grow toward Odoo's breadth without
inflicting Odoo's complexity on a store.**

## 5. Sequencing

Ordered by unlock-per-unit-work against the 34-app frequency analysis.
**BIND** = a product exists. **BUILD** = ours to write.

### Tier 0 — take out of order (free, or about a day)

| | item | type | why now |
| --- | --- | --- | --- |
| 0a | **Turnstile** challenge | BIND, **free** | already spec'd (`forms.md` §2) |
| 0b | **Email Routing** intake | BIND, **free** | email → ticket/lead, no mailbox to run |
| 0c | **Transition `before` veto** (§2.6b) | BUILD, ~1 day | **the cheapest item in the audit** — purely additive to an existing type |

### Tier 1 — the three that move everything

1. **Policy expression at method / transition / field / row (§2.6)** — BUILD,
   small-to-medium. Ranked *above* relations because it is additive to an
   existing structure, it is a **correctness fix** (it closes the fail-open
   field-level PII gap, `collections.md` §3a) and not merely a feature, and
   it ships with 0c.
2. **Aggregation (§2.3)** — BIND Analytics Engine *for metering* **+ BUILD** a
   D1 group-by API *for record-scoped rollups*. 29/34, the widest unlock, and
   the thing the incumbent actually charges for.
3. **Relations, widened (§2.1)** — BUILD. 32/34, the highest raw frequency,
   third only because it is the largest and because 1 and 2 ship value on
   their own. **Start with the `collection-config` field enum** — the engine
   already supports references; the config surface hides them.

### Tier 2

4. **Automation, re-shaped (§2.2)** — BIND Workflows + BUILD the rule
   document. `gamification` is the free reference implementation.
5. **Time-triggered transitions (§2.10)** — BUILD, small; a rider on 1 and 4.
6. **The Durable Objects three-for-one (§2.7)** — BIND. Sequences (§2.4) +
   concurrency-safe reservation + hibernatable WebSockets for text/presence.
   One binding, three gaps — the best ratio after Tier 1.
7. **Balances (§2.5)** — BUILD, platform-owned. **Profile B first**
   (single-unit + write-time sufficiency), because `pricing.md` already
   requires it for credits and it simultaneously delivers karma, progress,
   points, leave and SMS metering. Profiles A (double-entry) and C (stock)
   follow. Fold the hash-chained audit trail in here.

### Tier 3

8. **Record mixins (§2.9)** — BUILD, medium; needs 1 and 3.
9. **Portal/per-record tokens** — BUILD, small.
10. **Resource calendars and temporal booking** — BUILD, medium; demand is
    understated here (the Services category was not audited).

## 6. Non-goals

- Porting Odoo's data models or its ORM semantics.
- Module install/upgrade machinery — capabilities are bound, not installed.
- Building CRM/HR/Project as bespoke apps: they are collections with
  relations, states, and automation. If they are not, §2 is incomplete and
  that is the finding.
