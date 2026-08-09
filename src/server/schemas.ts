import { z } from "zod";
import { resourceDocumentSchema, zodFromFields } from "hono-aep-cms";
import { envRefSchema } from "./generated/env-ref-schema";

/**
 * Hosted JSON Schemas (baas/sync.md §6 / seed.md §7): every file in a
 * config or seed repo carries a `$schema` pointing back HERE, so editors
 * validate + autocomplete against the same contract the server enforces.
 * Two derivation tiers keep drift impossible where it matters most:
 * collection definitions convert the ACTUAL server-side zod validator
 * (resourceDocumentSchema → JSON Schema), and per-project row schemas
 * are built live from each collection's stored definition
 * (zodFromFields → JSON Schema). The rest are hand-authored against the
 * documented shapes. `bin/validate.ts` walks a repo and enforces.
 */

type Json = Record<string, unknown>;
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Suite composition (customPackages/spec/suite.json): the canonical
 * schemas carry non-fetchable hono-aep.dev $ids — this surface is their
 * FETCHABLE MIRROR, and file-kind schemas compose them by $ref
 * (EnvRef's configString for any literal-or-secret value).
 */
const envString = (base: string): Json => ({ $ref: `${base}/env-ref.json#/$defs/configString` });

const globList = (description: string): Json => ({
  type: "array",
  description,
  items: { type: "string", description: "A glob relative to the repo root." },
});

/** Wrap a schema body with the draft header + a legal $schema property. */
const doc = (id: string, description: string, body: Json): Json => ({
  $schema: DRAFT,
  $id: id,
  description,
  ...body,
  properties: { $schema: { type: "string" }, ...(body.properties as Json | undefined) },
});

const SITE_ASSETS: Json = {
  type: "object",
  description: "Drivers for the hosted /site/{asset} surface.",
  additionalProperties: true,
  properties: {
    og: {
      type: "object",
      description: "Per-collection OG-card field mappings (/site/og/{plural}/{id}.png).",
      additionalProperties: {
        type: "object",
        properties: {
          kicker: { type: "string" }, title: { type: "string" },
          subtitle: { type: "string" }, money: { type: "string", description: "A cents field rendered as a price badge." },
        },
        additionalProperties: false,
      },
    },
    robots: { type: "object", properties: { extra: { type: "array", items: { type: "string" } } }, additionalProperties: false },
    sitemap: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" } },
        collections: {
          type: "array",
          items: { type: "object", required: ["slug", "url"], properties: { slug: { type: "string" }, url: { type: "string", description: "Path template; {id} expands per row." } }, additionalProperties: false },
        },
      },
      additionalProperties: false,
    },
    llms: {
      type: "object",
      properties: {
        intro: { type: "string" },
        sections: { type: "array", items: { type: "object", required: ["title", "collection", "url"], properties: { title: { type: "string" }, collection: { type: "string" }, url: { type: "string" }, label: { type: "string" }, note: { type: "string" } }, additionalProperties: false } },
        links: { type: "array", items: { type: "object", required: ["title", "url"], properties: { title: { type: "string" }, url: { type: "string" }, note: { type: "string" } }, additionalProperties: false } },
      },
      additionalProperties: false,
    },
  },
};

const SITE: Json = {
  type: "object",
  description: "The site document — drives theme.css consumers, locales, admin composition and the hosted assets.",
  additionalProperties: true,
  properties: {
    url: { type: "string", format: "uri", description: "The public frontend base URL (absolute sitemap/llms/manifest URLs derive from it)." },
    description: { type: "string" },
    locale: { type: "string" },
    locales: {
      type: "object",
      properties: { default: { type: "string" }, supported: { type: "array", items: { type: "string" } } },
      additionalProperties: true,
    },
    admin: {
      type: "object",
      description: "Composes the generated admin (hosted /site/admin.html AND self-hosted copies).",
      properties: {
        commerce: { type: "boolean", description: "Show the commerce Stats/Orders panes." },
        collections: {
          type: "array",
          items: {
            oneOf: [
              { type: "string", description: "Collection plural — a generated CRUD tab." },
              { type: "object", required: ["slug"], properties: { slug: { type: "string" }, idField: { type: "string", description: "Field whose value becomes the id on create." }, media: { type: "array", items: { type: "string" }, description: "Fields edited as media uploads." } }, additionalProperties: false },
            ],
          },
        },
      },
      additionalProperties: false,
    },
    app: {
      type: "object",
      description: "PWA/brand identity — manifest, generated favicon, OG accents, sw cache.",
      properties: {
        name: { type: "string" }, shortName: { type: "string" },
        themeColor: { type: "string", description: "Manifest theme_color (browser chrome) — NOT the brand accent." },
        accentColor: { type: "string", description: "The brand accent used by OG cards + the generated favicon." },
        backgroundColor: { type: "string" }, cacheName: { type: "string" },
        favicon: { type: "string", description: "Raw SVG override for /site/favicon.svg." },
        icons: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: false,
    },
    assets: SITE_ASSETS,
  },
};

const STATIC_SCHEMAS: Record<string, (base: string) => Json> = {
  "env-ref": (base) => {
    // The suite-canonical EnvRef, $id AND internal self-$refs rewritten to
    // the fetchable mirror (the canonical hono-aep.dev id doesn't resolve).
    const mirrored = JSON.parse(
      JSON.stringify(envRefSchema).replaceAll(envRefSchema.$id, `${base}/env-ref.json`),
    ) as Json;
    return { ...mirrored, $comment: `canonical: ${envRefSchema.$id}` };
  },
  "platform-creds": (base) =>
    doc(`${base}/platform-creds.json`, ".platform-creds.json — the GITIGNORED local value store (spec/secrets.md §3.1): NAME → value; sync/seed resolve EnvRefs here before the process env. Never commit.", {
      type: "object",
      patternProperties: { "^[A-Z][A-Z0-9_]*$": { type: "string" } },
      additionalProperties: false,
    }),
  "secrets-config": (base) =>
    doc(`${base}/secrets-config.json`, "secrets.cms.json — per-project secrets (spec/secrets.md §3): NAME → literal or EnvRef resolved by the sync client; values never live in git.", {
      type: "object",
      patternProperties: { "^[A-Z][A-Z0-9_]*$": envString(base) },
      additionalProperties: false,
    }),
  "baas-config": (base) =>
    doc(`${base}/baas-config.json`, "hono-aep-baas-config/baas.json — the sync client's coordinates.", {
      type: "object",
      required: ["endpoint", "project", "resources"],
      properties: {
        endpoint: { type: "string", format: "uri" },
        project: { type: "string" },
        resources: globList("Definition-plane files to sync (forms/themes/collections globs)."),
      },
      additionalProperties: false,
    }),
  "project-config": (base) =>
    doc(`${base}/project-config.json`, "project.cms.json — the project document, merge-PATCHed by sync.", {
      type: "object",
      properties: {
        display_name: { type: "string" },
        auth_pool: { type: "object", description: "better-auth pool config (emailPassword/social/twoFactor/anonymous/trustedOrigins).", additionalProperties: true },
        site: SITE,
        create_time: { type: "string" }, update_time: { type: "string" }, created_by: { type: "string" },
      },
      additionalProperties: true,
    }),
  "collection-config": (base) => {
    const definition = z.toJSONSchema(resourceDocumentSchema, { target: "draft-2020-12", io: "input" }) as Json;
    delete definition.$schema;
    // export_name is the `.cms.ts` dialect's TS-export identifier — JIT
    // documents don't carry one (the server derives what it needs).
    if (Array.isArray(definition.required)) {
      definition.required = definition.required.filter((key) => key !== "export_name");
    }
    return doc(`${base}/collection-config.json`, "collections/*.cms.json — a JIT resource definition (validated by the server's own resourceDocumentSchema).", {
      type: "object",
      required: ["definition"],
      properties: { definition },
      additionalProperties: true,
    });
  },
  "form-config": (base) =>
    doc(`${base}/form-config.json`, "forms/*.cms.json — a forms-as-a-service form.", {
      type: "object",
      required: ["display_name"],
      properties: {
        display_name: { type: "string" },
        notify_email: { type: "string", format: "email" },
        create_time: { type: "string" }, update_time: { type: "string" }, created_by: { type: "string" },
        submit_key: { type: "string", description: "Server-owned pk_ submit key (reified by pull)." },
      },
      additionalProperties: true,
    }),
  "seed-config": (base) =>
    doc(`${base}/seed-config.json`, "hono-aep-baas-idempotent-seed/seed.json — the seed manifest (seed.md).", {
      type: "object",
      required: ["endpoint", "project", "resources"],
      properties: {
        endpoint: { type: "string", format: "uri" },
        project: { type: "string" },
        resources: {
          type: "array",
          description: "Data-plane row files. String glob, or {glob, as} to write as a specific seeded user.",
          items: {
            oneOf: [
              { type: "string" },
              { type: "object", required: ["glob"], properties: { glob: { type: "string" }, as: { type: "string", description: "users/*.json file whose session performs these writes." } }, additionalProperties: false },
            ],
          },
        },
        users: globList("End-user account files (auth-pool sign-ups)."),
      },
      additionalProperties: false,
    }),
  "seed-user": (base) =>
    doc(`${base}/seed-user.json`, "users/*.json — an auth-pool account the seed ensures exists.", {
      type: "object",
      required: ["email"],
      properties: { email: { type: "string", format: "email" }, name: { type: "string" }, password: envString(base) },
      additionalProperties: true,
    }),
  "seed-lock": (base) =>
    doc(`${base}/seed-lock.json`, "seed-lock.json — the machine-managed idempotency ledger. Do not edit by hand.", {
      type: "object",
      additionalProperties: true,
    }),
};

export const SCHEMA_KINDS = Object.keys(STATIC_SCHEMAS);

export function staticSchema(kind: string, base: string): Json | null {
  return STATIC_SCHEMAS[kind]?.(base) ?? null;
}

/** Live per-collection row schema for seed files: the stored definition's wire shape. */
export function rowsSchema(definition: Json, id: string): Json {
  const fields = Array.isArray(definition.fields) ? definition.fields : [];
  let body: Json;
  try {
    body = z.toJSONSchema(zodFromFields(fields as never), { target: "draft-2020-12", io: "input" }) as Json;
    delete body.$schema;
  } catch {
    body = { type: "object", additionalProperties: true };
  }
  return {
    $schema: DRAFT,
    $id: id,
    description: `A ${String(definition.singular ?? "row")} seed file — generated from the live collection definition (localized fields are {locale: value} maps, the ?locale=all authoring shape).`,
    ...body,
    properties: { $schema: { type: "string" }, ...(body.properties as Json | undefined) },
  };
}
