# Commerce

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/commerce`
**Status:** draft

## Abstract

E-commerce as a COMPOSITION, not a monolith. A storefront is a canonical
resource model (product → variant → cart → order) plus a canonical EVENT
taxonomy, wired to kinds the suite already has — billing (checkout →
payment), notifications (order email), search (product search),
connections (order webhooks), observability (funnels). An app that
adopts this spec declares its catalog and ships a thin storefront; it
writes NO cart logic, NO order state machine, NO event plumbing — those
are the capability. The reference consumer (saastarter2) hand-rolls all
of that today; this spec is the demand to delete it.

The load-bearing idea (from PostHog's ecommerce-events spec): **the
event vocabulary is the contract.** Analytics, order emails, outbound
webhooks, and inventory all consume ONE typed stream, so "what happened
in the store" has a single definition every consumer agrees on.

## 1. The resource model

Canonical dialect shapes (JIT collections, baas/collections.md). An app
adopts them as-is or extends fields; the flows and events below assume
these names. All are owner-scoped where a customer owns the row (cart,
order); catalog reads are public.

```
projects/{p}/products/{product}                 (public read)
projects/{p}/products/{product}/variants/{v}    (sku, price, inventory)
projects/{p}/carts/{cart}                        (owner: customer; items[])
projects/{p}/orders/{order}                      (owner: customer; state machine)
projects/{p}/discounts/{code}                    (owner: merchant)
```

- **product** — `slug` (unique), `name`, `description`, `category`,
  `images[]`, `featured`; price lives on variants (a product with no
  variants gets a synthetic `default` variant).
- **variant** — `sku` (unique), `name`, `price_cents`, `currency`,
  `inventory` (integer; null ≡ unlimited), `attributes` (JSON: size,
  color, …).
- **cart** — `customer` (owner ref), `items[]` (`{variant, quantity}`),
  `status` (`active` → `converted` | `abandoned`), `currency`; totals
  are DERIVED, never stored (a read computes them from live variant
  prices — no torn cart when a price changes).
- **order** — `customer`, `items[]` (line items SNAPSHOT price/name at
  order time — the one place denormalization is correct, because an
  order is a historical record), `total_cents`, `currency`, `discount`,
  a fulfillment state machine (§3), `payment` (billing operation ref).
- **discount** — `code` (unique), `kind` (`percent` | `fixed`),
  `value`, `min_cents`, `max_uses`, `used`, `valid_from`/`valid_to`,
  `applies_to` (product/category globs). Validation is a declared verb,
  not app code.

## 2. The event taxonomy (the contract)

The canonical commerce events, PostHog-aligned names, each with a typed
property schema. TWO origins:

- **derived** — the framework emits it from a resource mutation or
  transition (aep/events): `orders.{id}.create` → `order_completed`
  once paid, `orders.{id}.refund` → `order_refunded`. Server-authored,
  trustworthy, the ones money and email hang off.
- **client** — the storefront `track()`s read/funnel events the server
  can't see: `product_viewed`, `product_list_viewed`,
  `checkout_started`, `checkout_step_viewed`. Untrusted, analytics-only.

| event | origin | key properties |
|---|---|---|
| `product_list_viewed` | client | `list_id`, `category`, `products[]` |
| `product_viewed` | client | `product_id`, `sku`, `name`, `category`, `price_cents`, `currency` |
| `product_clicked` | client | `product_id`, `position` |
| `product_added` | derived (cart item-added) | `cart_id`, `product_id`, `variant`, `quantity`, `price_cents` |
| `product_removed` | derived | `cart_id`, `product_id`, `variant` |
| `cart_viewed` | client | `cart_id`, `products[]`, `total_cents` |
| `checkout_started` | client | `checkout_id`, `cart_id`, `total_cents`, `currency`, `products[]` |
| `checkout_step_viewed` | client | `checkout_id`, `step`, `step_name` |
| `payment_info_entered` | client | `checkout_id`, `payment_method` |
| `order_completed` | **derived** (order paid) | `order_id`, `total_cents`, `revenue_cents`, `tax_cents`, `shipping_cents`, `discount`, `coupon`, `currency`, `products[]` |
| `order_updated` | derived (fulfillment transition) | `order_id`, `status` |
| `order_refunded` | **derived** | `order_id`, `refund_cents`, `reason` |
| `order_cancelled` | derived | `order_id`, `reason` |
| `coupon_applied` / `coupon_denied` | derived (discount verb) | `checkout_id`, `coupon`, `discount_cents` \| `reason` |
| `product_added_to_wishlist` | derived | `product_id`, `wishlist_id` |

The shared **line item** (`products[]`) shape, embedded:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hono-aep.dev/spec/2026-08/baas/commerce/line-item.json",
  "title": "Commerce line item",
  "type": "object",
  "properties": {
    "product_id": { "type": "string" },
    "sku": { "type": "string" },
    "name": { "type": "string" },
    "variant": { "type": "string" },
    "category": { "type": "string" },
    "price_cents": { "type": "integer", "minimum": 0 },
    "quantity": { "type": "integer", "minimum": 1 },
    "position": { "type": "integer" }
  },
  "required": ["product_id", "price_cents", "quantity"]
}
```

The **event envelope** rides aep/events for derived events (`type` is
the commerce event name, `data` carries the properties) and a dedicated
`track` endpoint for client events — one vocabulary, two ingress paths.

## 3. Flows (declarative — no hosted code)

1. **Add to cart** — `POST carts/{c}:add-item {variant, quantity}` (a
   declared custom method): validates inventory, appends/merges the
   line, emits `product_added`. Remove/clear are the mirror verbs.
2. **Checkout** — `POST carts/{c}:checkout` creates an `order` in
   `pending` from the cart's live totals, then opens payment in one of
   two modes: `hosted` (the billing kind's provider-hosted session,
   billing.md) or `embedded` (gateway.md — the NEUTRAL gateway's
   createPayment returns `{gateway, clientToken, client}` and the
   storefront renders the provider's element inside ITS OWN page; the
   order coordinates ride the payment metadata). The cart STAYS
   `active` — checkout is an attempt, not a commitment; an abandoned or
   failed payment leaves the shopper's cart exactly as it was.
3. **Payment → order** — the VERIFIED provider webhook — billing's for
   hosted sessions, the gateway driver's normalized `payment.succeeded`
   (gateway.md §2) for embedded payments — fires the order's
   `:pay` transition: `pending → paid`. THAT transition (aep/events)
   is what emits the trustworthy `order_completed`, which the
   notifications kind turns into the confirmation email and the
   connections producer delivers as an outbound webhook. Inventory
   decrements on the same transition — and so does cart CONVERSION:
   the order remembers its source cart, and `:pay` marks THAT cart
   `converted` (the shopper's cart clears exactly when the money is
   real, never before).
4. **Fulfillment** — the order state machine, all declared transitions:
   `paid → fulfilled → shipped → delivered`, plus `→ refunded` /
   `→ cancelled` (each emitting its event). Merchant-policied — and
   DRIVEN by the delivery kind (delivery.md §3): virtual deliveries
   (download artifacts over media) walk the machine automatically on the
   paid transition; courier/parcel drivers walk it from their provider
   webhooks; `manual` stays the merchant's hand.
5. **Discounts** — `POST discounts/{code}:validate {cart}` returns the
   computed discount or a denial reason (emits `coupon_applied` /
   `coupon_denied`). Applied at checkout as a line adjustment.

Every step is a transition or a declared verb with bindings — the same
machinery collections/forms already use. The app supplies handlers for
NOTHING here; a consumer that needs bespoke logic (tax by region, say)
adds it in its own thin server (collections.md §4), never hosted.

### 3a. Guest checkout

A guest is not a special case of commerce — a guest is an ANONYMOUS
PRINCIPAL (auth-pools.md §1.8). The storefront calls
`POST auth/sign-in/anonymous` and receives a bearer session like any
other; every flow above then works UNCHANGED,
because carts, orders, and wishlists are owner-scoped to principals, not
to "accounts". Consequences, all by construction rather than by code:

1. **No parallel guest-cart machinery.** The cart table, the checkout
   verb, the payment→order bridge, inventory, and coupons are identical
   for guests — commerce cannot even distinguish them.
2. **The provider collects the contact point.** Hosted checkout (Stripe)
   asks for the guest's email; the order confirmation reaches them
   without the pool ever holding a real address.
3. **Upgrade carries the history.** When a guest signs up (or in) while
   holding their anonymous session, the pool's link hook fires and the
   platform RE-PARENTS the guest's rows — cart, orders, wishlist,
   entitlement grants, customer mapping — to the new principal. A guest
   who buys and registers a week later keeps what they bought.
4. **Anonymous principals are policy-visible.** `authenticated` admits
   them (they hold a session); an app that wants member-only surfaces
   uses entitlements or roles, not "has an account".

5. **Guest is the DEFAULT, not a choice.** The storefront SHOULD mint
   the anonymous session implicitly on the FIRST action that needs a
   principal (add-to-cart, wishlist, review) — no "continue as guest"
   button, no interruption, no gate before checkout. Sign-in/sign-up
   stays offered throughout the flow (the nav treats an anonymous
   session as signed-out for its call-to-action), and taking it at ANY
   point — before or after paying — triggers §3a.3's re-parenting.

Conformance addition: a deployment enabling guest checkout MUST enable
the pool's anonymous knob and SHOULD wire the link hook's re-parenting —
an upgrade that silently orphans a guest's paid orders fails §3a.3. A
storefront that interposes an auth gate (even a guest button) before
add-to-cart fails §3a.5's SHOULD.

## 4. Analytics (the PostHog use case)

The event stream feeds observability wide events; the canonical funnel
is `product_viewed → product_added → checkout_started →
order_completed`, computable because every step shares `products[]` +
ids. Client events post to `POST projects/{p}/commerce/track` (rate-
limited per quotas.md, dropped on spam posture); derived events are
authoritative. A consumer wanting an external analytics sink (PostHog,
etc.) subscribes via the connections producer — the commerce events use
the aep/events grammar, so nothing bespoke.

## 5. What this deletes from an app

saastarter2 today hand-writes: a products fetch, a category filter, a
product-detail buy, a checkout POST, order polling, and ad-hoc "buy →
entitlement" wiring — and has NO cart, NO order lifecycle, NO events.
Under this spec it declares the catalog collections (config) and renders
`<ProductGrid>` / `<Cart>` / `<Checkout>` from hono-aep-ui over the
canonical contract, emitting typed events via a thin `track()`. The
cart math, order state machine, payment→order bridge, confirmation
email, inventory, and funnel are the capability. Target: the storefront
frontend drops to catalog config + presentation, mirroring how forms
collapsed to one `<form>` tag.

## 6. Non-goals

Multi-currency conversion (store one currency per cart; display-only FX
is the app's), tax computation (a provider/binding, not core — the
`tax_cents` field is carried, not calculated), shipping-rate engines,
and subscriptions (billing's recurring path, separate). Marketplaces
(multi-vendor) reopen when a second seller axis is needed — recorded,
like §3a tenancy.

## 7. Conformance

- Cart totals MUST be derived at read time; only orders snapshot prices.
- `order_completed` MUST originate from the server-side paid transition,
  never a client `track()` — money-bearing events are not client-trusted.
- Every event MUST validate against its property schema; the shared
  line item is the one embedded here.
- Inventory decrement and `order_completed` MUST be the SAME transition
  (no double-sell window).
- The cart MUST survive an abandoned or failed payment; conversion
  happens on the paid transition, keyed to the order's source cart.

## 8. References

- PostHog ecommerce-events spec (the event-taxonomy model this adopts)
- baas: collections.md (the resource model), billing.md (hosted
  checkout, subscriptions), quotas.md (track rate limit), site.md
  (storefront rendering)
- gateway.md (the NEUTRAL payment-gateway contract behind embedded
  checkout), delivery.md (the NEUTRAL delivery contract driving §3.4)
- suite: aep/events (derived-event grammar), notifications / connections
  / search / observability kinds, AEP-136 (custom verbs), AEP-216
  (order state machine)
