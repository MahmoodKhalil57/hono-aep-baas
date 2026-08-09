import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The idempotent-seed client (baas/spec/seed.md): `diff | push [--prune] |
 * pull [--adopt <plural>/<id|*>] | fmt | destroy --yes` against a
 * `hono-aep-baas-idempotent-seed/` directory. The DATA-plane sibling of
 * bin/sync.ts: one Apply per row through the public contract, a lock
 * ledger (`seed-lock.json`) bounding prune/destroy to seed-owned rows,
 * and TRUE no-ops — an unchanged row issues zero writes (spec §4).
 *
 *   BAAS_KEY=sk_… bun bin/seed.ts push --dir ../saastarter2/hono-aep-baas-idempotent-seed
 */

type ResourceEntry = string | { glob: string; as: string };
type Manifest = {
  endpoint: string | { $env: string };
  project: string | { $env: string };
  resources: ResourceEntry[];
  users?: string[];
};
type Json = Record<string, unknown>;
type Lock = { rows: string[] };

const OUTPUT_ONLY = new Set(["path", "create_time", "update_time", "delete_time", "state", "created_by", "$schema"]);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Json = {};
    for (const key of Object.keys(value as Json).sort()) out[key] = canonical((value as Json)[key]);
    return out;
  }
  return value;
};
const print = (value: Json): string => `${JSON.stringify(canonical(value), null, 2)}\n`;
const stripOutputOnly = (value: Json): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !OUTPUT_ONLY.has(key)));
const equal = (a: Json, b: Json): boolean =>
  JSON.stringify(canonical(stripOutputOnly(a))) === JSON.stringify(canonical(stripOutputOnly(b)));

/**
 * EnvRefs ({"$env": NAME}) resolve at run time — secrets never in files
 * (§3.4). The ladder (spec/secrets.md §3.1): platform-creds.json (the
 * gitignored repo-root sibling of .owner-creds.json) over the process env.
 */
let platformCreds: Record<string, string> = {};
const loadPlatformCreds = (dir: string): void => {
  for (const candidate of [join(dir, "platform-creds.json"), join(dir, "..", "platform-creds.json")]) {
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as Json;
      platformCreds = Object.fromEntries(
        Object.entries(raw).filter(([name, value]) => name !== "$schema" && typeof value === "string"),
      ) as Record<string, string>;
      return;
    } catch {
      /* try the next location */
    }
  }
};
const resolveEnv = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(resolveEnv);
  if (value !== null && typeof value === "object") {
    const record = value as Json;
    if (typeof record["$env"] === "string" && Object.keys(record).length === 1) {
      const name = record["$env"] as string;
      const resolved = platformCreds[name] ?? process.env[name];
      if (resolved === undefined) throw new Error(`EnvRef $env:${name} not in platform-creds.json nor the env`);
      return resolved;
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, resolveEnv(v)]));
  }
  return value;
};

export type SeedContext = { dir: string; key: string; fetchImpl?: typeof fetch; log?: (line: string) => void };

const loadManifest = (dir: string): { endpoint: string; project: string; manifest: Manifest } => {
  loadPlatformCreds(dir); // before any EnvRef resolves
  const manifest = JSON.parse(readFileSync(join(dir, "seed.json"), "utf8")) as Manifest;
  return {
    endpoint: resolveEnv(manifest.endpoint) as string,
    project: resolveEnv(manifest.project) as string,
    manifest,
  };
};
const loadLock = (dir: string): Lock => {
  try {
    return JSON.parse(readFileSync(join(dir, "seed-lock.json"), "utf8")) as Lock;
  } catch {
    return { rows: [] };
  }
};
const saveLock = (dir: string, lock: Lock): void => {
  writeFileSync(join(dir, "seed-lock.json"), print({ rows: [...new Set(lock.rows)].sort() } as unknown as Json));
};

type RowFile = { file: string; plural: string; slug: string; body: Json; as?: string };

/** A seed file carrying a definition violates the plane separation (§1). */
const assertDataPlane = (file: string, body: Json): void => {
  if ("definition" in body || file.endsWith(".cms.json") || file.endsWith(".cms.css")) {
    throw new Error(`${file}: definitions belong in hono-aep-baas-config/, not the seed (seed.md §1)`);
  }
};

const loadRows = (dir: string, manifest: Manifest): RowFile[] => {
  const rows: RowFile[] = [];
  for (const entry of manifest.resources) {
    const glob = typeof entry === "string" ? entry : entry.glob;
    const as = typeof entry === "string" ? undefined : entry.as;
    const [plural] = glob.split("/") as [string];
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, plural)).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const file = `${plural}/${name}`;
      const body = stripOutputOnly(JSON.parse(readFileSync(join(dir, file), "utf8")) as Json);
      assertDataPlane(file, body);
      rows.push({ file, plural, slug: name.slice(0, -".json".length), body, ...(as ? { as } : {}) });
    }
  }
  return rows;
};

type UserFile = { file: string; email: string; name: string; password: string };
const loadUsers = (dir: string, manifest: Manifest): UserFile[] => {
  const users: UserFile[] = [];
  for (const glob of manifest.users ?? []) {
    const [folder] = glob.split("/") as [string];
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, folder)).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const body = resolveEnv(JSON.parse(readFileSync(join(dir, folder, name), "utf8"))) as Json;
      users.push({
        file: `${folder}/${name}`,
        email: String(body["email"]),
        name: String(body["name"] ?? "Seed User"),
        password: String(body["password"]),
      });
    }
  }
  return users;
};

const makeApi = (context: SeedContext, endpoint: string) => {
  const doFetch = context.fetchImpl ?? fetch;
  return async (
    method: string,
    path: string,
    body?: Json,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    doFetch(`${endpoint}/v1/${path}`, {
      method,
      headers: {
        ...(headers["Authorization"] ? {} : { Authorization: `Bearer ${context.key}` }),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
};

/** Demo principals (§7): sign-in, else sign-up; both land a bearer token. */
async function userToken(context: SeedContext, endpoint: string, project: string, user: UserFile): Promise<string> {
  const doFetch = context.fetchImpl ?? fetch;
  const auth = (path: string, body: Json) =>
    doFetch(`${endpoint}/v1/projects/${project}/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const signIn = await auth("/sign-in/email", { email: user.email, password: user.password });
  const fromSignIn = signIn.headers.get("set-auth-token");
  if (fromSignIn) return fromSignIn;
  const signUp = await auth("/sign-up/email", { email: user.email, password: user.password, name: user.name });
  const fromSignUp = signUp.headers.get("set-auth-token");
  if (!fromSignUp) throw new Error(`${user.file}: could not sign in or up (${signIn.status}/${signUp.status})`);
  return fromSignUp;
}

type PlanEntry = { path: string; file?: string; action: "create" | "update" | "noop" | "prune" };

export async function diff(context: SeedContext): Promise<PlanEntry[]> {
  const { endpoint, project, manifest } = loadManifest(context.dir);
  const call = makeApi(context, endpoint);
  const lock = loadLock(context.dir);
  const rows = loadRows(context.dir, manifest);
  const plan: PlanEntry[] = [];
  for (const row of rows) {
    const path = `projects/${project}/${row.plural}/${row.slug}`;
    const current = await call("GET", `${path}?locale=all`); // authoring shape: raw maps
    if (current.status === 404) plan.push({ path, file: row.file, action: "create" });
    else if (!current.ok) throw new Error(`GET ${path} → ${current.status}`);
    else {
      const account = (await current.json()) as Json;
      plan.push({
        path,
        file: row.file,
        action: equal(account, resolveEnv(row.body) as Json) ? "noop" : "update",
      });
    }
  }
  const declared = new Set(rows.map((row) => `${row.plural}/${row.slug}`));
  for (const owned of lock.rows) {
    if (!declared.has(owned)) plan.push({ path: `projects/${project}/${owned}`, action: "prune" });
  }
  return plan;
}

export async function push(
  context: SeedContext,
  options: { prune?: boolean } = {},
): Promise<{ applied: number; noops: number; pruned: number; users: number }> {
  const { endpoint, project, manifest } = loadManifest(context.dir);
  const call = makeApi(context, endpoint);
  const log = context.log ?? (() => {});
  const lock = loadLock(context.dir);

  // Demo principals first — rows may run `as` them.
  const tokens = new Map<string, string>();
  let users = 0;
  for (const user of loadUsers(context.dir, manifest)) {
    tokens.set(user.file, await userToken(context, endpoint, project, user));
    users += 1;
    log(`user  ${user.file} (${user.email}) ready`);
  }

  let applied = 0;
  let noops = 0;
  for (const row of loadRows(context.dir, manifest)) {
    const path = `projects/${project}/${row.plural}/${row.slug}`;
    const headers: Record<string, string> = {};
    if (row.as) {
      const token = tokens.get(row.as);
      if (!token) throw new Error(`${row.file}: as="${row.as}" is not a declared user`);
      headers["Authorization"] = `Bearer ${token}`;
    }
    const desired = resolveEnv(row.body) as Json;
    const current = await call("GET", `${path}?locale=all`, undefined, headers); // raw maps
    if (current.ok && equal((await current.clone().json()) as Json, desired)) {
      noops += 1; // TRUE no-op: no Apply, no update_time churn, no events (§4)
    } else {
      const etag = current.ok ? current.headers.get("etag") : null;
      const put = await call("PUT", `${path}?locale=all`, desired, { ...headers, ...(etag ? { "If-Match": etag } : {}) });
      if (!put.ok) throw new Error(`PUT ${path} → ${put.status}: ${(await put.text()).slice(0, 200)}`);
      applied += 1;
      log(`${current.status === 404 ? "create" : "update"} ${path}`);
    }
    if (!lock.rows.includes(`${row.plural}/${row.slug}`)) lock.rows.push(`${row.plural}/${row.slug}`);
  }

  let pruned = 0;
  if (options.prune) {
    const declared = new Set(loadRows(context.dir, manifest).map((row) => `${row.plural}/${row.slug}`));
    const candidates = lock.rows.filter((owned) => !declared.has(owned));
    for (const owned of candidates) log(`prune ${owned}`); // list first (§4)
    for (const owned of candidates) {
      const del = await call("DELETE", `projects/${project}/${owned}`);
      if (del.ok || del.status === 404) {
        lock.rows = lock.rows.filter((row) => row !== owned);
        pruned += 1;
      } else throw new Error(`DELETE ${owned} → ${del.status}`);
    }
  }
  saveLock(context.dir, lock);
  return { applied, noops, pruned, users };
}

export async function pull(context: SeedContext, adopt: string[] = []): Promise<{ written: number }> {
  const { endpoint, project, manifest } = loadManifest(context.dir);
  const call = makeApi(context, endpoint);
  const lock = loadLock(context.dir);
  const targets = new Set(lock.rows);
  for (const pattern of adopt) {
    const [plural, id] = pattern.split("/") as [string, string];
    if (id === "*") {
      const listed = await call("GET", `projects/${project}/${plural}?max_page_size=1000`);
      if (!listed.ok) throw new Error(`LIST ${plural} → ${listed.status}`);
      for (const row of ((await listed.json()) as { results: { path: string }[] }).results) {
        targets.add(`${plural}/${row.path.split("/").pop()!}`);
      }
    } else targets.add(pattern);
  }
  let written = 0;
  for (const target of [...targets].sort()) {
    const current = await call("GET", `projects/${project}/${target}?locale=all`);
    if (!current.ok) continue; // deleted server-side; prune will reconcile
    const body = stripOutputOnly((await current.json()) as Json);
    const file = join(context.dir, `${target}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, print(body));
    if (!lock.rows.includes(target)) lock.rows.push(target);
    written += 1;
  }
  saveLock(context.dir, lock);
  return { written };
}

export async function destroy(context: SeedContext): Promise<{ deleted: number }> {
  const { endpoint, project } = loadManifest(context.dir);
  const call = makeApi(context, endpoint);
  const log = context.log ?? (() => {});
  const lock = loadLock(context.dir);
  for (const owned of lock.rows) log(`delete ${owned}`); // list first (§4)
  let deleted = 0;
  for (const owned of [...lock.rows]) {
    const del = await call("DELETE", `projects/${project}/${owned}`);
    if (del.ok || del.status === 404) {
      lock.rows = lock.rows.filter((row) => row !== owned);
      deleted += 1;
    } else throw new Error(`DELETE ${owned} → ${del.status}`);
  }
  saveLock(context.dir, lock);
  return { deleted };
}

export function fmt(dir: string): number {
  const { manifest } = loadManifest(dir);
  let reprinted = 0;
  for (const row of loadRows(dir, manifest)) {
    writeFileSync(join(dir, row.file), print(row.body));
    reprinted += 1;
  }
  return reprinted;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2);
  const flag = (name: string): boolean => rest.includes(name);
  const value = (name: string): string | undefined => {
    const at = rest.indexOf(name);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  const values = (name: string): string[] =>
    rest.flatMap((arg, at) => (arg === name && rest[at + 1] ? [rest[at + 1]!] : []));
  const dir = value("--dir") ?? "hono-aep-baas-idempotent-seed";
  const key = process.env["BAAS_KEY"] ?? "";
  if (!existsSync(join(dir, "seed.json"))) {
    console.error(`no seed.json in ${dir}`);
    process.exit(2);
  }
  const context: SeedContext = { dir, key, log: (line) => console.log(line) };
  switch (verb) {
    case "diff": {
      const plan = await diff(context);
      for (const entry of plan) console.log(`${entry.action.padEnd(6)} ${entry.path}`);
      const changes = plan.filter((entry) => entry.action !== "noop").length;
      console.log(`${changes} change(s), ${plan.length - changes} noop(s)`);
      if (flag("--exit-code") && changes > 0) process.exit(1);
      break;
    }
    case "push": {
      const out = await push(context, { prune: flag("--prune") });
      console.log(`applied ${out.applied}, noops ${out.noops}, pruned ${out.pruned}, users ${out.users}`);
      break;
    }
    case "pull": {
      const out = await pull(context, values("--adopt"));
      console.log(`wrote ${out.written} file(s)`);
      break;
    }
    case "fmt":
      console.log(`reprinted ${fmt(dir)} file(s)`);
      break;
    case "destroy": {
      if (!flag("--yes")) {
        console.error("destroy deletes every lock-listed row; pass --yes to confirm");
        process.exit(2);
      }
      const out = await destroy(context);
      console.log(`deleted ${out.deleted} row(s)`);
      break;
    }
    default:
      console.error("usage: seed.ts <diff|push [--prune]|pull [--adopt plural/id|plural/*]|fmt|destroy --yes> [--dir path]");
      process.exit(2);
  }
}
