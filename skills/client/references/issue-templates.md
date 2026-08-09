# Issue templates — MahmoodKhalil57/hono-aep-baas

Search before filing:
`gh issue list -R MahmoodKhalil57/hono-aep-baas --search "<terms>" --state all`

## Bug

```sh
gh issue create -R MahmoodKhalil57/hono-aep-baas \
  --title "bug(/v1/...): <one-line contradiction of spec/openapi>" \
  --body "$(cat <<'EOF'
**Endpoint**: GET /v1/projects/{p}/…
**X-Request-Id**: <from the failing response — indexes the platform's wide-event log>
**Project**: <project id — never the sk_ key>
**Expected** (per spec/openapi): …
**Actual**: status + body excerpt
**Repro**: minimal curl (no secrets)
EOF
)"
```

## Feature request (platform-side capability)

```sh
gh issue create -R MahmoodKhalil57/hono-aep-baas \
  --title "feat(<area>): <capability>" \
  --body "$(cat <<'EOF'
**Use-case**: what the site owner is trying to ship, in one paragraph.
**Why it cannot be static**: which part must execute on the platform
(server logic / secret custody / webhook / scheduled work).
**Proposed public contract**: the route/field/driver shape — must fit
the one-write-surface law (a public /v1 addition, never a backdoor).
Drivers (payment/delivery/email) are platform-owner additions by
design — name the provider and link its API docs.
**Workaround today**: what the site does meanwhile (e.g. manual
fulfilment from the admin), or "none".
EOF
)"
```

Rules: no secrets, sk_ keys, session tokens, or customer PII in issues.
Project ids and X-Request-Ids are safe and useful.
