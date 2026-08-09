// Suite-canonical EnvRef schema (customPackages/spec/suite.json → hono-aep-cms)
// mirrored VERBATIM for fetchable hosting; the canonical $id stays in $comment.
// Source: hono-aep-cms/spec/env-ref.schema.json — re-copy on suite changes.
export const envRefSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hono-aep.dev/spec/2026-08/cms/env-ref.json",
  "title": "EnvRef",
  "description": "A reference to a secret or environment value BY NAME. Service configuration MUST reference sensitive values through EnvRef and MUST NOT inline them: the CMS validates presence and never displays values; the encrypted .env (dotenvx) is the committable store locally, and a sync tool mirrors names into the deployment platform's secret store (e.g. `wrangler secret put`). Report cards MUST surface, per referenced name, presence in each environment. Non-secret configuration MAY be written inline.",
  "type": "object",
  "properties": {
    "$env": {
      "type": "string",
      "pattern": "^[A-Z][A-Z0-9_]*$",
      "description": "The environment variable name this value resolves from at runtime."
    }
  },
  "required": [
    "$env"
  ],
  "additionalProperties": false,
  "examples": [
    {
      "$env": "STRIPE_SECRET_KEY"
    }
  ],
  "$defs": {
    "secretString": {
      "description": "A value that is secret by nature: MUST be an EnvRef, never a literal.",
      "$ref": "https://hono-aep.dev/spec/2026-08/cms/env-ref.json",
      "$anchor": "secret-string"
    },
    "configString": {
      "description": "A value that MAY be a literal (non-secret) or an EnvRef (environment-dependent).",
      "oneOf": [
        {
          "type": "string"
        },
        {
          "$ref": "https://hono-aep.dev/spec/2026-08/cms/env-ref.json"
        }
      ],
      "$anchor": "config-string"
    }
  }
} as const;
