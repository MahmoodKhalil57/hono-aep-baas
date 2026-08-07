# Forms as a Service

**Identifier:** `https://hono-aep.dev/spec/2026-08/baas/forms`
**Status:** draft

## 1. The submission endpoint

`POST /v1/projects/{project}/forms/{form}/submissions` — standard AEP
Create (AIP-133) with a `public` create policy, plus a stable alias
`POST /submit/{key}` resolving the form from a publishable key
(keys.md) so an HTML form needs exactly one attribute:

```html
<form action="https://…/submit/pk_live_abc123" method="POST">
```

Requirements:

1. **Content negotiation:** `application/x-www-form-urlencoded`,
   `multipart/form-data` (attachments), and `application/json` MUST all
   be accepted; the stored submission is the canonical JSON form.
2. **Reserved control fields** use the `_` prefix and are stripped from
   the stored payload — data fields and control fields never mix:
   - `_redirect` — URL to 303 to on success (else a hosted thank-you
     page; JSON callers get 201 + resource).
   - `_botcheck` — the honeypot (§2).
   - `_replyto` — the submitter address the autoresponder targets (§3).
3. **Idempotency:** AEP-155 `request_id` honored when supplied; browser
   double-posts without one are mitigated by a short content-hash
   dedupe window (declared in the form config, default 30s).
4. **CORS:** the submit surface returns wildcard `*` CORS for
   bearer-key requests (and their preflights). Safe by the Stripe
   argument: publishable keys are not cookies — browsers never attach
   them automatically, so there is no CSRF surface, and a key holder
   can already call the API directly. Without this, the JS-enhanced
   `fetch` submission path breaks cross-origin, silently favoring the
   no-JS path. Origin ALLOWLISTS (§2.3) still apply after CORS — CORS
   is browser courtesy, the allowlist is enforcement.
5. **No-JS constraint:** every behavior here MUST work from a static
   `<form>` — 303 redirects, not fetch responses; challenge widgets
   (§2) are progressive enhancement with a server-verified fallback.

## 2. Spam posture

Layered, cheapest first; each layer's outcome is recorded on the
submission (`spam_verdict` metadata), never silently dropped:

1. **Honeypot:** a filled `_botcheck` accepts with 200/303 (never tip
   off the bot) and marks the submission `SPAM`.
2. **Challenge binding (`x-challenge`)** on the create method: a
   provider-agnostic captcha verification (Turnstile, hCaptcha) as a
   capability-service instance; the create handler verifies the
   challenge token server-side before acceptance. Fail-closed when the
   form declares a challenge and the token is absent/invalid;
   degrade-open ONLY on provider outage (bindings.md degrade rules),
   marking the submission `UNVERIFIED`.
3. **Domain allowlist:** when the form declares `allowed_domains`,
   Origin/Referer outside the list is rejected 403 (RFC 9457).
4. Rate limits per key/IP: quotas.md.

## 3. Delivery pipeline

`submissions.{id}.create` (aep/events grammar) fans out — this feature
is deliberately the first consumer of all three event surfaces:

| consumer | binding | behavior |
|---|---|---|
| notifications | form `notify` → owner Targets | email to the form's notification addresses |
| notifications | autoresponder template + `_replyto` Target | reply to the submitter, when enabled |
| jobs | `enqueue` deliver-webhook | Standard Webhooks POST per connections producer spec, retries per queue config |

All delivery is async through jobs (bindings never compute); each
delivery attempt is an AEP-151 operation, so the dashboard's delivery
history is the generated operations surface — no bespoke UI. A parked
(retry-exhausted) delivery raises the form's report card, not a silent
loss. Submission states: `RECEIVED → DELIVERED | PARKED` (+ `SPAM`,
`UNVERIFIED` verdicts orthogonal to delivery).

## 4. Owner surface

- The dashboard IS the generated admin over `submissions` with owner
  pushdown; filters are AEP-160 CEL — nothing bespoke.
- Export: AEP-153 `:export` (CSV first) as an operation.
- Retention: forms declare `retention_days`; expiry runs soft-delete →
  purge (AEP-164/165) via a cron job entry. Default: retain forever.
- Attachments: media-bound file fields; stored via the media service,
  linked from the submission; size caps per form, counted against
  project quota (quotas.md).

## 5. Report card

Per form: delivery health (parked/delivered ratio), spam ratio,
challenge verification rate, quota headroom, deliverability of the
notification domain (SPF/DKIM/DMARC — the observability kind's card
when it lands, marked degraded until then).

## 6. References

- AIP-133, AEP-151/153/155/160/164/165, aep/events, RFC 9457
- cms/bindings.md (degrade rules), notifications kind (Target model),
  connections kind (Standard Webhooks producer), baas/keys.md,
  baas/quotas.md
