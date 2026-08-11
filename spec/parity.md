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

The product goal is **Odoo's breadth at saastarter2's setup cost**: an
Odoo app is installed and configured; the equivalent here should be a
config file a beginner can read. Anything that cannot be delivered that way
does not belong in the catalog yet.

## 1. What the catalog already covers

| Odoo app | our capability | state |
| --- | --- | --- |
| Website Builder | `page`, `block`, `theme` | ✅ |
| eCommerce | `collection` + commerce.md, `gateway`, `delivery` | ✅ |
| Blog / Knowledge | `collection`, `page` | ✅ generic |
| Surveys / Helpdesk intake | `form`, `submission` | ✅ |
| Projects & Tasks | `collection` + states/transitions | ✅ generic |
| Subscriptions (entitlements) | `billing` | ◐ grants, not dunning |
| Email (transactional) | `notifications` | ◐ transactional, not campaigns |
| Documents | `media` | ◐ storage, no versioning/sign |
| Discuss | — | ✗ |

The "generic ✅" rows matter: a CRM pipeline, a task board, and a recruiting
funnel are all *a collection with states and transitions*. We do not need a
CRM module; we need collections to stay expressive.

## 2. The primitives that are actually missing

Each unlocks a family of Odoo apps. This is the real roadmap.

### 2.1 Relations (`reference` → first-class)

Odoo's power is that records *point at each other* and the UI, reports, and
integrity rules follow. We are further along than the gap suggests:
`reference` and `references` both exist as field types, carrying
`{resource, collection, titleField}` — so the target and cardinality ARE
declared, and the admin already renders a picker from them.

What is missing is everything *downstream* of the declaration: no cascade
or restrict rule, no reverse accessor (a customer cannot list its orders
without a filter written by hand), and no referential integrity at write
time — a reference may point at a row that does not exist.

Unlocks: CRM (contact→opportunity), Sales (order→lines), Helpdesk
(ticket→customer), Projects (task→project) — essentially every app.

### 2.2 Automation (declarative, event-driven)

"When a sale order is confirmed, create an invoice." We have events and a
jobs queue, so the *substrate* exists; what is missing is a declarative
rule a beginner can write and read, instead of code.

Unlocks: Marketing Automation, Approvals, Helpdesk SLAs, every
cross-resource Odoo workflow.

### 2.3 Aggregation and reporting

Odoo ships pivot/graph views over every model. We have list/get with
filters and no aggregation at all — no `sum`, `group by`, or measure.

Unlocks: every dashboard, and the reporting half of every app above.

### 2.4 Sequences

Invoice and order numbering with per-scope, gap-free, formatted counters
(`INV/2026/0042`). counters.md is adjacent but is a public metric counter,
not a transactional sequence.

Unlocks: Invoicing, Sales, Purchase, Inventory — anything with a document
number, which is most of finance.

### 2.5 Ledger (the one that cannot be generic)

Double-entry accounting is **not** a collection with states. It carries
invariants — debits equal credits, periods close, entries are immutable
once posted — that a document store cannot enforce and that a beginner must
never be able to misconfigure into an unbalanced book.

Unlocks: Accounting, Invoicing, Expenses, Payroll.

> **This is the honest boundary.** Ledger, stock valuation, and tax
> engines are domain capabilities with real invariants; they must be
> PLATFORM capabilities (kinds.md §1: new behavior is a platform change,
> not a document). Everything in §2.1–2.4 is a generic primitive. Pretending
> otherwise is how a CMS becomes a bad ERP.

### 2.6 Per-transition authorization

Odoo's approval chains are states plus **who may move them**. Checked, and
the gap is precise: `TransitionDefinition` carries `from`, `to`,
`description`, and an `after` hook — but **no policy**. Policies are
per-METHOD (list/get/create/update/delete), so today "anyone who may call
the resource may fire any transition it permits".

That makes a two-step approval inexpressible: *submitter* may
`draft → submitted`, but only an *approver* may `submitted → approved`.
Adding `policy` to a transition is a small, well-scoped change to an
existing structure, and it is the difference between a state machine and an
approval chain.

Unlocks: Approvals, Expenses, Purchase agreements, Helpdesk escalation,
editorial publish gates.

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

### Deliberately excluded

- **Stream** — video. The expensive class, and avoidable: R2 already stores
  bytes egress-free, and an embed from a third-party host costs nothing.
- **Realtime / Calls** — SFU pricing for a capability no listed app needs.
- **Containers / Sandboxes** — heavier compute than a Worker for problems a
  Worker solves.
- **Hyperdrive** — pooling for external databases we do not have.
- **Pages** — the consumer frontends already ship on GitHub Pages.

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

Ordered by unlock-per-unit-work, not by app popularity:

1. **Relations** (§2.1) — BUILD. The widest unlock, and the only one with no
   product behind it: cascade, reverse accessors and write-time integrity are
   ours to write.
2. **Aggregation** (§2.3) — BIND Analytics Engine. Dashboards with no new
   data model.
3. **Sequences** (§2.4) — BIND Durable Objects. Small, self-contained,
   unblocks every document number.
4. **Automation** (§2.2) — BIND Workflows over the events we already emit.
5. **Ledger** (§2.5) — BUILD, platform-owned. Largest and most
   invariant-heavy; deliberately last.

Free wins worth taking out of order because they cost almost nothing:
**Turnstile** (the already-spec'd forms challenge) and **Email Routing**
(inbound intake), both free.

## 6. Non-goals

- Porting Odoo's data models or its ORM semantics.
- Module install/upgrade machinery — capabilities are bound, not installed.
- Building CRM/HR/Project as bespoke apps: they are collections with
  relations, states, and automation. If they are not, §2 is incomplete and
  that is the finding.
