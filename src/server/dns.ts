import { AepProblem } from "hono-aep";

/**
 * BYOK DNS (spec/dns.md): the customer hands us a scoped credential for the
 * zone they already control, and we write the records their domain needs
 * instead of dictating them and waiting.
 *
 * WHAT THIS IS NOT. A customer token cannot route their hostname to our
 * Worker — a Worker is addressed by OUR account id, and Cloudflare refuses a
 * Custom Domain "on a zone you do not own" (workers/configuration/routing/
 * custom-domains.mdx:37). Cross-account CNAME to `*.workers.dev` fails two
 * ways: unproxied it dies at TLS, proxied it returns 1014 Cross-User Banned.
 * Routing for `kind: api` is Cloudflare for SaaS on OUR zone with OUR token,
 * which is a separate, platform-side step this module does not perform.
 *
 * So: this writes records. It is the difference between "publish this TXT,
 * then come back" and one round-trip — which is the whole UX win, and it is
 * honest about being only that.
 *
 * v1 IS ADDITIVE ONLY. It creates records that are missing and reports
 * everything else. It never updates, never deletes, and never touches a
 * record it did not create — so there is no path, however deep the bug, in
 * which we destroy a customer's MX, SPF or apex. A conflict is a REPORT, not
 * a merge: the caller is told exactly what is in the way and fixes it by
 * hand. Destructive authority can be added later behind an explicit,
 * server-issued confirmation; it cannot be taken back once granted.
 */

/** What we stamp on every record we create, so we can recognise our own. */
export const markerFor = (projectId: string, host: string): string =>
  `hono-aep:${projectId}:${host}`;

export type DesiredRecord = {
  type: "TXT" | "CNAME" | "A" | "AAAA";
  /** Fully-qualified owner name. */
  name: string;
  content: string;
  /**
   * Cloudflare's orange cloud. Deliberately explicit on every record rather
   * than defaulted: it is the single most consequential field here, and the
   * right value differs per record type (a GitHub Pages CNAME must be
   * unproxied or certificate issuance breaks; a challenge TXT cannot be
   * proxied at all).
   */
  proxied: boolean;
};

export type PlanEntry = {
  record: DesiredRecord;
  /** `create` — absent, we will add it. `present` — already exactly right.
   *  `conflict` — something else holds the name; we report and stop. */
  action: "create" | "present" | "conflict";
  detail?: string;
};

export type DnsZone = { id: string; name: string };

/** The seam. A second provider implements this and nothing upstream moves. */
export type DnsProvider = {
  readonly name: string;
  /** Every zone the credential can see — also the de-facto scope report. */
  zones(): Promise<DnsZone[]>;
  list(zoneId: string, name: string): Promise<{ id: string; type: string; name: string; content: string; proxied?: boolean; comment?: string | null }[]>;
  create(zoneId: string, record: DesiredRecord, comment: string): Promise<void>;
};

/** Overridable so an integration test can point at a local stub provider. */
const cfApi = (): string =>
  process.env["CLOUDFLARE_API_BASE"] ?? "https://api.cloudflare.com/client/v4";

/**
 * The fetch this module talks to the provider through.
 *
 * A seam rather than a parameter threaded through every call site: the code
 * that holds a customer's account credential is the last code that should be
 * untested, and the alternative is exercising it against a real Cloudflare
 * account with a real token.
 */
let currentFetch: typeof fetch | null = null;
export const setDnsFetch = (impl: typeof fetch | null): void => void (currentFetch = impl);
export const dnsFetch = (): typeof fetch => currentFetch ?? fetch;

type CfResponse<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] };

const cfProblem = (status: number, errors: { code: number; message: string }[] | undefined, fallback: string): AepProblem => {
  const first = errors?.[0];
  // 9109/1000 are Cloudflare's "this token cannot do that" family; 6003 is a
  // malformed credential. All three mean the same thing to the caller —
  // reconnect the account — and none should read as our outage.
  const scope = status === 403 || first?.code === 9109 || first?.code === 1000;
  return new AepProblem({
    type: scope ? "PERMISSION_DENIED" : status === 404 ? "NOT_FOUND" : "FAILED_PRECONDITION",
    status: scope ? 403 : status === 404 ? 404 : 409,
    title: scope ? "The connected DNS credential cannot do that." : "The DNS provider refused the request.",
    // NEVER interpolate the token. Cloudflare's message is safe (it echoes
    // codes, not credentials), but the rule is the rule.
    detail: first ? `${first.message} (Cloudflare code ${first.code})` : fallback,
  });
};

/**
 * A Cloudflare token, used narrowly.
 *
 * `fetchImpl` is injected so tests can drive this without network access and
 * without a real credential — the alternative is an untested client holding
 * someone's account keys.
 */
export const cloudflareDns = (token: string, fetchImpl: typeof fetch = fetch): DnsProvider => {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(`${cfApi()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      // A provisioning call is user-facing: a hung provider must fail, not
      // hold the request open until the isolate is torn down.
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as CfResponse<T>;
    if (!response.ok || !body.success) {
      throw cfProblem(response.status, body.errors, `Cloudflare returned ${response.status}.`);
    }
    return body.result;
  };

  return {
    name: "cloudflare",
    async zones() {
      const result = await call<{ id: string; name: string }[]>("/zones?per_page=50");
      return result.map((zone) => ({ id: zone.id, name: zone.name }));
    },
    async list(zoneId, name) {
      // The filter is a REQUEST, not a guarantee: Cloudflare list endpoints
      // may ignore a parameter they do not recognise, and a silently
      // unfiltered response would look like "the zone is full of records at
      // this name". Callers re-check `name` themselves.
      return await call(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
    },
    async create(zoneId, record, comment) {
      await call(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          content: record.content,
          proxied: record.proxied,
          ttl: 1, // "automatic" — the only sane default for records we manage
          comment,
        }),
      });
    },
  };
};

/**
 * Pick the zone that actually contains a host: the LONGEST zone name that is
 * a suffix of it, at a label boundary.
 *
 * Longest wins because both `example.com` and `shop.example.com` can be zones
 * in one account, and writing `api.shop.example.com` into the parent zone
 * would be shadowed by the child's nameservers and never resolve.
 */
export const zoneForHost = (host: string, zones: readonly DnsZone[]): DnsZone | null => {
  const name = host.toLowerCase().replace(/\.$/, "");
  const matches = zones.filter((zone) => {
    const candidate = zone.name.toLowerCase();
    return name === candidate || name.endsWith(`.${candidate}`);
  });
  return matches.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
};

/**
 * A CNAME cannot share an owner name with any other type (RFC 1034 §3.6.2),
 * and Cloudflare rejects the whole request when one does. Catching it here
 * turns an opaque provider error into a plan we can explain — and stops us
 * ever sending a batch that cannot succeed.
 */
export const cnameCollisions = (records: readonly DesiredRecord[]): string[] =>
  [...new Set(records.map((record) => record.name.toLowerCase()))].filter((name) => {
    const atName = records.filter((record) => record.name.toLowerCase() === name);
    return atName.length > 1 && atName.some((record) => record.type === "CNAME");
  });

/**
 * Compare desired against live and classify each record. Nothing is written
 * here — a plan is always computable without side effects, which is what
 * makes a dry run trustworthy rather than a promise.
 */
export const planRecords = async (
  provider: DnsProvider,
  zoneId: string,
  desired: readonly DesiredRecord[],
  marker: string,
): Promise<PlanEntry[]> => {
  const plan: PlanEntry[] = [];
  for (const record of desired) {
    const live = (await provider.list(zoneId, record.name)).filter(
      // Re-filter in code: see `list`. Never trust the server-side filter to
      // have narrowed anything.
      (row) => row.name.toLowerCase() === record.name.toLowerCase(),
    );
    const sameValue = live.find(
      (row) => row.type === record.type && row.content.replace(/^"|"$/g, "") === record.content,
    );
    if (sameValue) {
      // Right value, wrong proxy flag is NOT "already correct". A proxied
      // Pages CNAME resolves and then fails certificate issuance — the exact
      // breakage `proxied: false` exists to prevent — so reporting it as
      // present would return success for the state the rule forbids. It
      // cannot be a `create` either (the name is occupied), and this provider
      // never modifies, so it is a conflict the owner must resolve.
      const proxyMismatch =
        record.type !== "TXT" &&
        typeof sameValue.proxied === "boolean" &&
        sameValue.proxied !== record.proxied;
      plan.push(
        proxyMismatch
          ? {
              record,
              action: "conflict",
              detail: `${record.name} already points where it should, but is ${sameValue.proxied ? "proxied" : "DNS-only"} and must be ${record.proxied ? "proxied" : "DNS-only"}. Change it in your DNS provider, then retry.`,
            }
          : { record, action: "present" },
      );
      continue;
    }
    if (live.length === 0) {
      plan.push({ record, action: "create" });
      continue;
    }
    // Something else is here. A CNAME cannot coexist with anything, and a
    // second record of a type that permits duplicates (TXT) is usually
    // someone else's and must not be assumed replaceable.
    plan.push({
      record,
      action: "conflict",
      detail:
        record.type === "CNAME" || live.some((row) => row.type === "CNAME")
          ? `${record.name} already holds a ${live[0]!.type} record, and a CNAME cannot share a name. Remove it, then retry.`
          : `${record.name} already holds a ${live[0]!.type} record with different content. Left untouched — remove or correct it, then retry.`,
    });
  }
  return plan;
};

/** Apply only the `create` entries. Additive by construction (see header). */
export const applyPlan = async (
  provider: DnsProvider,
  zoneId: string,
  plan: readonly PlanEntry[],
  marker: string,
): Promise<number> => {
  let created = 0;
  for (const entry of plan) {
    if (entry.action !== "create") continue;
    await provider.create(zoneId, entry.record, marker);
    created += 1;
  }
  return created;
};
