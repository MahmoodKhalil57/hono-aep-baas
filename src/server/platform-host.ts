/**
 * The free fallback surface (domains.md §1a).
 *
 * One wildcard DNS record plus one wildcard route on the platform's own zone
 * gives every project an API hostname at zero marginal cost and with NO
 * per-project DNS: the moment a project exists, `{project}-api.{suffix}`
 * answers. Bringing a real domain later is an addition, never a migration —
 * a verified custom domain simply wins first (see `domainSurface`).
 *
 * Two grammars resolve, so the prettier form is a DNS change rather than a
 * code change:
 *
 *   `{project}-api.{suffix}`  ONE label deep, so a zone's free Universal SSL
 *                             certificate covers it. This is the shipped form.
 *   `{project}.api.{suffix}`  Two deep — needs Advanced Certificate Manager
 *                             on the zone before TLS will terminate.
 *
 * Only the API is served here. The frontend keeps its own host (site.md: the
 * baas hosts what the frontend READS, never the frontend), and a wildcard can
 * only point at ONE origin anyway — every project's site is a different Pages
 * deployment, so there is nothing coherent a wildcard could mean for it.
 *
 * The fallback is derived, never declared: no `domains` row, no challenge, no
 * verification step — ownership is not in question because we are the
 * registrant. That is precisely what makes it both free to hand out and
 * centrally withdrawable.
 */

/** AEP-122 ids, and long enough to hold a uuid. */
const PROJECT_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Resolve a Host to the project whose API it is, or null when the host is not
 * on the platform zone (a custom domain, or nothing we serve).
 *
 * `host` may carry a port and any casing; `suffix` is the platform zone
 * (`saastemly.com`) and disables the fallback entirely when empty, which is
 * the correct default for a deployment that owns no zone.
 */
export const platformFallbackProject = (host: string, suffix: string): string | null => {
  const zone = suffix.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!zone) return null;
  const name = host.trim().toLowerCase().split(":")[0]!;
  if (!name.endsWith(`.${zone}`)) return null;

  const label = name.slice(0, -(zone.length + 1));
  // Both grammars end in the same four characters; the separator is the only
  // difference, and either way the project is what precedes it.
  const project = label.endsWith("-api") || label.endsWith(".api") ? label.slice(0, -4) : null;
  return project && PROJECT_LABEL.test(project) ? project : null;
};

/**
 * Hosts on the platform zone that a project may never CLAIM as a custom
 * domain (domains.md §1a.3, §7.6).
 *
 * Claiming is not routing, but the two meet: an ACTIVE `domains` row wins
 * resolution ahead of everything, so a tenant that claims `{victim}-api.{zone}`
 * takes that tenant's free host, and one that claims the apex takes the
 * console. Neither needs any DNS proof to be attempted, and a merely PENDING
 * row is enough to 404 a host that would otherwise have worked — a claim is a
 * denial of service even when it fails.
 *
 * Note what is NOT reserved: an operator running the platform on a zone they
 * also use for their own projects still needs `api.{project}.{zone}` to work.
 * Only the apex, the platform's own service labels, and the derived fallback
 * grammar are withheld.
 */
const RESERVED_LABELS = new Set([
  "api", "www", "studio", "admin", "mail", "email", "fallback", "customers", "cname", "dashboard",
]);

/**
 * Any host on the platform zone — the CLAIM-time rule.
 *
 * Stricter than `isReservedPlatformHost` on purpose, and the two are
 * deliberately not the same predicate:
 *
 * - At CLAIM time the whole zone is off limits. A tenant holding
 *   `promo.{zone}` is brand hijacking even when it routes nowhere, and once
 *   the wildcard route exists every label on the zone reaches the worker.
 *   Projects do not need a claim here — they already have a derived host.
 * - At RESOLUTION time only the derived grammar and the platform's own
 *   service labels are refused outright, so an ACTIVE row an operator
 *   created out-of-band on their own zone keeps serving. Withdrawing
 *   routing from hosts that are already live is a bigger failure than the
 *   claim it would prevent, and claims are already closed at the door.
 */
export const isPlatformZoneHost = (host: string, suffix: string): boolean => {
  const zone = suffix.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!zone) return false;
  const name = host.trim().toLowerCase().split(":")[0]!.replace(/\.$/, "");
  return name === zone || name.endsWith(`.${zone}`);
};

export const isReservedPlatformHost = (host: string, suffix: string): boolean => {
  const zone = suffix.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!zone) return false;
  const name = host.trim().toLowerCase().split(":")[0]!.replace(/\.$/, "");
  if (name === zone) return true;
  if (!name.endsWith(`.${zone}`)) return false;
  if (platformFallbackProject(name, zone)) return true;
  const label = name.slice(0, -(zone.length + 1));
  // Only the leftmost-of-one case: `api.{zone}` is ours, `api.acme.{zone}` is
  // a project's own subdomain and stays claimable.
  return !label.includes(".") && RESERVED_LABELS.has(label);
};
