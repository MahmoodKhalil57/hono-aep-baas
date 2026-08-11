import { and, eq } from "drizzle-orm";
import { jsonRows } from "hono-aep-drizzle";
import { AepProblem } from "hono-aep";
import { db } from "../db/registry";
import { setSecret } from "./secrets";

/**
 * Click-to-connect (spec/connect.md): a project owner grants us access to
 * their Cloudflare account through Cloudflare's own consent screen, instead
 * of minting an API token by hand and pasting it.
 *
 * The credential lands in the SAME place a pasted one does — the project's
 * `CLOUDFLARE_API_TOKEN` secret — so `:provision` and everything downstream
 * are unchanged and cannot tell the difference.
 *
 * THE ATTACK THIS IS SHAPED AROUND. The callback arrives from the provider,
 * not from a signed-in user, so it cannot be owner-gated the normal way. The
 * naive design — commit the grant when the callback fires — loses to a
 * reverse-CSRF: Mallory starts a flow on HER project, sends the start link to
 * Alice, Alice consents with HER Cloudflare account, and Alice's grant is
 * spent on Mallory's project. Binding the flow to a browser cookie does not
 * fix it (the cookie is minted in Alice's browser), and binding it to the
 * starting principal does not either (Mallory is legitimately that principal).
 *
 * So committing requires BOTH, and they are held by different people in the
 * attack: the browser that completed consent has the cookie but not Mallory's
 * session; Mallory has the session but not the cookie. Neither can claim, and
 * the grant expires unused. That is the whole reason a claim step exists.
 */

const COLLECTION = "__oauth";
const SCOPE = "__platform";
const rows = jsonRows as unknown as Record<"scope" | "collection" | "parent" | "id", never>;

/** Long enough that a flow survives a slow consent screen, short enough that
 *  an abandoned one is not a standing liability. */
const FLOW_TTL_MS = 15 * 60 * 1000;

export const CONNECT_COOKIE = "__Host-aep_connect";

type Flow = {
  provider: string;
  project_id: string;
  /** The principal who started it — must be the one who finishes it. */
  principal: string;
  verifier: string;
  /** sha256 of the cookie value; the cookie itself is never stored. */
  cookie_digest: string;
  expires_time: string;
  /** Set once the callback has exchanged the code, before the owner claims. */
  pending?: { access_token: string; refresh_token?: string; expires_in?: number };
  used_at?: string;
};

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomB64 = (size: number): string => b64url(crypto.getRandomValues(new Uint8Array(size)));

export const sha256B64 = async (value: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));

const loadFlow = async (state: string): Promise<Flow | null> => {
  const found = (await db
    .select()
    .from(jsonRows)
    .where(and(
      eq(rows.scope, SCOPE as never),
      eq(rows.collection, COLLECTION as never),
      eq(rows.id, state as never),
    ))) as { data: Flow | null }[];
  return found[0]?.data ?? null;
};

const saveFlow = async (state: string, flow: Flow, insert: boolean): Promise<void> => {
  const now = new Date().toISOString();
  const where = and(
    eq(rows.scope, SCOPE as never),
    eq(rows.collection, COLLECTION as never),
    eq(rows.id, state as never),
  );
  if (insert) {
    await db.insert(jsonRows).values({
      scope: SCOPE, collection: COLLECTION, parent: "", id: state,
      data: flow, createTime: now, updateTime: now,
    } as never);
  } else {
    await db.update(jsonRows).set({ data: flow, updateTime: now } as never).where(where);
  }
};

const dropFlow = async (state: string): Promise<void> => {
  await db.delete(jsonRows).where(and(
    eq(rows.scope, SCOPE as never),
    eq(rows.collection, COLLECTION as never),
    eq(rows.id, state as never),
  ));
};

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

export type ConnectProvider = {
  slug: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  scopes: string[];
  /** Where the obtained credential is stored, so consumers stay unchanged. */
  secretName: string;
};

const oauthBase = (): string => process.env["CF_OAUTH_BASE"] ?? "https://dash.cloudflare.com/oauth2";

/**
 * Cloudflare's OAuth (GA 2026-06-03). Authorization Code + PKCE S256; the
 * device flow is explicitly NOT available to third-party clients, which is
 * why the existing GitHub device-flow precedent does not transfer here.
 *
 * SCOPES ARE UNVERIFIED. The exact strings must come from `GET /oauth/scopes`
 * against a registered client; `CF_OAUTH_SCOPES` exists so they can be
 * corrected without a deploy. Wrong scopes fail loudly at consent, which is
 * the right direction — but do not treat the default as confirmed.
 */
export const cloudflareConnect = (): ConnectProvider => ({
  slug: "cloudflare",
  authorizeUrl: `${oauthBase()}/auth`,
  tokenUrl: `${oauthBase()}/token`,
  revokeUrl: `${oauthBase()}/revoke`,
  scopes: (process.env["CF_OAUTH_SCOPES"] ?? "zone:read dns_records:edit offline_access").split(/\s+/).filter(Boolean),
  secretName: "CLOUDFLARE_API_TOKEN",
});

export const providerFor = (slug: string): ConnectProvider | null =>
  slug === "cloudflare" ? cloudflareConnect() : null;

/** Absent client credentials ⇒ the feature is OFF, not half-configured. */
export const connectConfigured = (): boolean =>
  Boolean(process.env["CF_OAUTH_CLIENT_ID"] && process.env["CF_OAUTH_CLIENT_SECRET"]);

/**
 * The one registered redirect URI. It must be a fixed, platform-owned origin:
 * OAuth requires an exact pre-registered value, and a tenant-supplied one
 * would let a project point the callback at a host it controls and harvest
 * authorization codes.
 */
export const redirectUri = (): string =>
  process.env["CONNECT_REDIRECT_URI"] ?? "https://mizan-gpp.the-montiapple.workers.dev/connect/callback";

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

export type StartResult = { authorize_url: string; cookie: string; expires_time: string };

export const startConnect = async (
  provider: ConnectProvider,
  projectId: string,
  principal: string,
): Promise<StartResult> => {
  const state = randomB64(32);
  const verifier = randomB64(48);
  const cookie = randomB64(32);
  const expires = new Date(Date.now() + FLOW_TTL_MS).toISOString();
  await saveFlow(state, {
    provider: provider.slug,
    project_id: projectId,
    principal,
    verifier,
    cookie_digest: await sha256B64(cookie),
    expires_time: expires,
  }, true);

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env["CF_OAUTH_CLIENT_ID"]!);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await sha256B64(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { authorize_url: url.toString(), cookie, expires_time: expires };
};

/* ------------------------------------------------------------------ */
/* Callback — exchange only. Never commit here.                        */
/* ------------------------------------------------------------------ */

export const exchangeCode = async (
  state: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; projectId: string } | { ok: false; reason: string }> => {
  const flow = await loadFlow(state);
  // An unknown state is the ordinary shape of a forged or replayed callback.
  if (!flow) return { ok: false, reason: "unknown or already-completed request" };
  if (flow.used_at) return { ok: false, reason: "this request was already completed" };
  if (Date.parse(flow.expires_time) < Date.now()) {
    await dropFlow(state);
    return { ok: false, reason: "the request expired — start again" };
  }
  if (flow.pending) return { ok: false, reason: "this request was already exchanged" };

  const provider = providerFor(flow.provider);
  if (!provider) return { ok: false, reason: "unknown provider" };

  const response = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: process.env["CF_OAUTH_CLIENT_ID"]!,
      client_secret: process.env["CF_OAUTH_CLIENT_SECRET"]!,
      code_verifier: flow.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    // Do not surface the provider's body: it can echo request parameters.
    return { ok: false, reason: `the provider rejected the exchange (${response.status})` };
  }
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; expires_in?: number;
  };
  if (!body.access_token) return { ok: false, reason: "the provider returned no token" };

  await saveFlow(state, {
    ...flow,
    pending: {
      access_token: body.access_token,
      ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
      ...(body.expires_in ? { expires_in: body.expires_in } : {}),
    },
  }, false);
  return { ok: true, projectId: flow.project_id };
};

/* ------------------------------------------------------------------ */
/* Claim — the commit, and the only owner-authenticated step           */
/* ------------------------------------------------------------------ */

export const claimConnect = async (
  state: string,
  projectId: string,
  principal: string,
  cookie: string | null,
): Promise<{ provider: string; secret: string }> => {
  const refuse = (detail: string): never => {
    throw new AepProblem({
      type: "FAILED_PRECONDITION",
      status: 409,
      title: "This connection could not be completed.",
      detail,
    });
  };
  const flow = await loadFlow(state);
  if (!flow || flow.used_at) refuse("Unknown or already-completed request. Start the connection again.");
  if (!flow!.pending) refuse("Consent has not been completed yet.");
  if (Date.parse(flow!.expires_time) < Date.now()) {
    await dropFlow(state);
    refuse("The request expired — start again.");
  }
  // BOTH bindings, and this is the whole security argument (see header):
  // the browser that consented holds the cookie, the owner holds the
  // session, and in the reverse-CSRF they are different people.
  if (flow!.principal !== principal) refuse("This connection was started by a different account.");
  if (flow!.project_id !== projectId) refuse("This connection was started for a different project.");
  if (!cookie || (await sha256B64(cookie)) !== flow!.cookie_digest) {
    refuse("Finish the connection in the browser window that started it.");
  }

  const provider = providerFor(flow!.provider)!;
  // Single-use: mark before writing, so a replay cannot re-commit even if
  // the write below fails and is retried.
  await saveFlow(state, { ...flow!, used_at: new Date().toISOString(), pending: undefined }, false);
  await setSecret(projectId, provider.secretName, flow!.pending!.access_token);
  await dropFlow(state);
  return { provider: provider.slug, secret: provider.secretName };
};

/** Housekeeping: abandoned flows hold a live grant until they expire. */
export const sweepExpiredFlows = async (): Promise<number> => {
  const all = (await db
    .select()
    .from(jsonRows)
    .where(and(eq(rows.scope, SCOPE as never), eq(rows.collection, COLLECTION as never)))) as {
    id: string; data: Flow | null;
  }[];
  let removed = 0;
  for (const row of all) {
    if (row.data && Date.parse(row.data.expires_time) < Date.now()) {
      await dropFlow(row.id);
      removed += 1;
    }
  }
  return removed;
};
