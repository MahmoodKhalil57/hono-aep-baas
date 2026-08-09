# Client recipes — request-level detail

`BASE = {endpoint}/v1/projects/{project}`. Public reads need no auth;
writes ride the caller's policy (anonymous session, signed-in user, or
sk_ owner key). Every response carries `X-Request-Id` — quote it in bug
reports.

## Rows (JIT collections)

```js
await fetch(`${BASE}/products?locale=en&max_page_size=50`)          // list → {results, next_page_token}
await fetch(`${BASE}/products?filter=${encodeURIComponent("category = 'plugin'")}`) // AEP-160 filter
await fetch(`${BASE}/products/billing-kit?locale=ar`)               // get, locale-resolved
await fetch(`${BASE}/products:search`, { method: "POST",            // ranked lexical search
  headers: J, body: JSON.stringify({ query: "stripe", max_results: 5 }) })
// writes (policy-gated): POST ?id={slug}&locale=, PATCH {id}?locale=, DELETE {id}
```

Row schemas for authoring: `{endpoint}/v1/projects/{p}/schemas/rows/{plural}.json`.

## Auth (bearer-first; auth-pools.md)

```js
const r = await fetch(`${BASE}/auth/sign-in/email`, { method: "POST", headers: J,
  body: JSON.stringify({ email, password }) });
token = r.headers.get("set-auth-token");                 // store; send as Authorization: Bearer
// 2FA challenge: response body {twoFactorRedirect:true} + set-two-factor-token header;
// verify: POST auth/two-factor/verify-totp with header two-factor-token: {that token}
// OAuth: location.href = `${BASE}/auth/sign-in/social/google?callbackURL=${site}`  (NAVIGATE, never fetch)
// → returns to callbackURL with #auth_token={session} in the fragment
// Anonymous (guest-by-default): POST auth/sign-in/anonymous → set-auth-token
```

## Commerce

```js
POST `${BASE}/commerce/cart/items`        { product_id, quantity }   // guest session ok
GET  `${BASE}/commerce/cart`
POST `${BASE}/commerce/cart:checkout`     { payment: "hosted" }      // → {url} Stripe redirect
POST `${BASE}/commerce/cart:checkout`     { payment: "embedded" }    // → {order, payment:{gateway, clientToken, client}}
GET  `${BASE}/commerce/orders`            // mine; owner key + ?all=1 → every order
POST `${BASE}/commerce/orders/{id}:advance` { to: "fulfilled" }      // merchant only
POST `${BASE}/commerce/discounts:validate`  { code, subtotal_cents }
GET  `${BASE}/commerce/stats`             // owner key
```

The cart stays until the order reaches PAID (webhook-driven). Embedded
mode uses the project's own Stripe keys when its secrets are set.

## Forms (static HTML, zero JS)

```html
<form action="{endpoint}/submit/{pk_submit_key}" method="POST">
  <input name="email"><input name="_replyto" type="hidden" value="…">
  <input name="_botcheck" style="display:none">  <!-- honeypot -->
</form>
```

## Media

```js
const fd = new FormData(); fd.append("file", file);
POST `${BASE}/media:upload` (Authorization required) → {results:[{path}]}
GET  `${BASE}/media/{id}` serves the bytes
```

## Theming

One link restyles everything: `<link rel="stylesheet" href="${BASE}/theme.css">`.
Themes speak the full tweakcn/shadcn token vocabulary (`--primary`,
`--radius`, `--font-sans`, `--sidebar-*`, `--shadow-*`, `.dark` block…);
pair with a bridge stylesheet mapping tokens into your CSS framework
(saastarter2's `css/tweakcn-adapter.css` maps ALL of them to Bootstrap).

## Hosted site assets (config-generated; site.md §2)

```
{BASE}/site/admin.html          the generated store admin (sk_ gate; same-origin with the API)
{BASE}/site/manifest.webmanifest, favicon.svg, sw.js, robots.txt, sitemap.xml, llms.txt
{BASE}/site/og.png              site OG card; {BASE}/site/og/{plural}/{id}.png per entity
```

Configure via `project.cms.json` → `site.app` / `site.assets` /
`site.admin`; frontends may self-host copies (robots/sw are
origin-bound — copy at publish).

## Contract-driven admin UI (the pattern to copy)

Fetch `{BASE}/openapi.json`, derive a model from `x-aep-resource` +
`x-aep-ui` per schema (fields carry label/widget/required/options;
localized fields marked via the schema's `x-i18n`), render tables and
forms from it. The `hono-aep-bootstrap-ui` npm-ready module implements
exactly this for no-build Bootstrap pages (adminModelFromDocument /
tableHtml / formHtml / readForm) — vendor its single file rather than
hand-writing per-collection UI. Which collections appear = the
`site.admin.collections` config, not code.
