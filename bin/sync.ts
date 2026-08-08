import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The sync client (baas/spec/sync.md): `diff | push [--prune] | pull | fmt`
 * against a `hono-aep-baas-config/` directory. Sync IS the contract — one
 * Apply (PUT + If-Match) per file, standard methods only; a private
 * endpoint here would violate sync.md §1.
 *
 *   BAAS_KEY=sk_… bun bin/sync.ts push --dir ../richPetShop2/hono-aep-baas-config
 */

type Manifest = { endpoint: string; project: string; resources: string[] };
type Json = Record<string, unknown>;

/** Server-owned fields: stripped on push, reified by pull (sync.md §2.3). */
const OUTPUT_ONLY = new Set([
  "path",
  "create_time",
  "update_time",
  "delete_time",
  "state",
  "created_by",
  "submit_key",
]);

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

export type SyncContext = {
  dir: string;
  key: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

type FileEntry = { file: string; plural: string; slug: string; body: Json; format: "json" | "css" };

const loadManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, "baas.json"), "utf8")) as Manifest;

/** `.cms.json` documents are JSON; `.cms.css` documents are raw css in a
 *  `{css}` envelope (themes — baas/site.md §1). */
const loadFiles = (dir: string, manifest: Manifest): FileEntry[] => {
  const entries: FileEntry[] = [];
  for (const pattern of manifest.resources) {
    const [plural, filePattern] = pattern.split("/") as [string, string];
    const format = filePattern?.endsWith(".cms.css")
      ? ("css" as const)
      : filePattern?.endsWith(".cms.json")
        ? ("json" as const)
        : null;
    if (!format) throw new Error(`unsupported glob '${pattern}'`);
    const suffix = format === "css" ? ".cms.css" : ".cms.json";
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, plural)).filter((name) => name.endsWith(suffix));
    } catch {
      continue; // the directory may not exist yet
    }
    for (const name of names.sort()) {
      const raw = readFileSync(join(dir, plural, name), "utf8");
      entries.push({
        file: `${plural}/${name}`,
        plural,
        slug: name.slice(0, -suffix.length),
        body: format === "css" ? { css: raw } : (JSON.parse(raw) as Json),
        format,
      });
    }
  }
  return entries;
};

const formatOf = (manifest: Manifest, plural: string): "json" | "css" =>
  manifest.resources.some((pattern) => pattern.startsWith(`${plural}/`) && pattern.endsWith(".cms.css"))
    ? "css"
    : "json";

const api = (context: SyncContext, manifest: Manifest) => {
  const doFetch = context.fetchImpl ?? fetch;
  return async (
    method: string,
    path: string,
    body?: Json,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    doFetch(`${manifest.endpoint}/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${context.key}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
};

type PlanEntry = {
  path: string;
  file?: string;
  action: "create" | "update" | "noop" | "prune";
};

/** The plan: per file create/update/noop, plus account-only prune candidates. */
export async function diff(context: SyncContext): Promise<PlanEntry[]> {
  const manifest = loadManifest(context.dir);
  const call = api(context, manifest);
  const plan: PlanEntry[] = [];

  const compare = async (path: string, file: string, body: Json): Promise<void> => {
    const current = await call("GET", path);
    if (current.status === 404) {
      plan.push({ path, file, action: "create" });
      return;
    }
    if (!current.ok) throw new Error(`GET ${path} → ${current.status}`);
    const account = stripOutputOnly((await current.json()) as Json);
    const desired = stripOutputOnly(body);
    plan.push({
      path,
      file,
      action: JSON.stringify(canonical(account)) === JSON.stringify(canonical(desired)) ? "noop" : "update",
    });
  };

  const projectFile = ((): Json => {
    try {
      return JSON.parse(readFileSync(join(context.dir, "project.cms.json"), "utf8")) as Json;
    } catch {
      return { display_name: manifest.project };
    }
  })();
  await compare(`projects/${manifest.project}`, "project.cms.json", projectFile);

  const files = loadFiles(context.dir, manifest);
  const declaredByPlural = new Map<string, Set<string>>();
  for (const entry of files) {
    const slugs = declaredByPlural.get(entry.plural) ?? new Set();
    slugs.add(entry.slug);
    declaredByPlural.set(entry.plural, slugs);
    await compare(`projects/${manifest.project}/${entry.plural}/${entry.slug}`, entry.file, entry.body);
  }

  // Account-side resources absent from the repo → prune candidates.
  for (const [plural, slugs] of declaredByPlural) {
    const listed = await call("GET", `projects/${manifest.project}/${plural}?max_page_size=1000`);
    if (!listed.ok) continue;
    const body = (await listed.json()) as { results: { path: string }[] };
    for (const row of body.results) {
      const slug = row.path.split("/").pop()!;
      if (!slugs.has(slug)) plan.push({ path: row.path, action: "prune" });
    }
  }
  return plan;
}

/** One Apply per file, dependency order; prune only with the explicit flag. */
export async function push(
  context: SyncContext,
  options: { prune?: boolean } = {},
): Promise<{ applied: number; pruned: number; noops: number }> {
  const manifest = loadManifest(context.dir);
  const call = api(context, manifest);
  const log = context.log ?? (() => {});
  const plan = await diff(context);
  const bodies = new Map(loadFiles(context.dir, manifest).map((entry) => [entry.file, entry.body]));
  let applied = 0;
  let pruned = 0;
  let noops = 0;

  const applyOne = async (path: string, body: Json): Promise<void> => {
    const current = await call("GET", path);
    const etag = current.headers.get("ETag");
    const response = await call(
      "PUT",
      path,
      stripOutputOnly(body),
      current.ok && etag ? { "If-Match": etag } : {},
    );
    if (response.status === 412) {
      throw new Error(
        `drift: ${path} changed on the account since your last pull — run \`sync pull\`, review, and push again (sync.md §4).`,
      );
    }
    if (!response.ok) {
      throw new Error(`PUT ${path} → ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
  };

  for (const entry of plan) {
    if (entry.action === "noop") {
      noops += 1;
      continue;
    }
    if (entry.action === "prune") {
      if (!options.prune) {
        log(`SKIP prune ${entry.path} (re-run with --prune to delete)`);
        continue;
      }
      log(`DELETE ${entry.path}`);
      const response = await call("DELETE", entry.path);
      if (!response.ok && response.status !== 204) {
        throw new Error(`DELETE ${entry.path} → ${response.status}`);
      }
      pruned += 1;
      continue;
    }
    const body =
      entry.file === "project.cms.json"
        ? ((): Json => {
            try {
              return JSON.parse(readFileSync(join(context.dir, "project.cms.json"), "utf8")) as Json;
            } catch {
              return { display_name: manifest.project };
            }
          })()
        : bodies.get(entry.file!)!; // css files are {css} envelopes, never JSON.parse'd
    log(`${entry.action.toUpperCase()} ${entry.path}`);
    await applyOne(entry.path, body);
    applied += 1;
  }
  return { applied, pruned, noops };
}

/** Reify account state into canonical files (output-only fields included). */
export async function pull(context: SyncContext): Promise<{ written: string[] }> {
  const manifest = loadManifest(context.dir);
  const call = api(context, manifest);
  const written: string[] = [];

  const write = (file: string, body: Json): void => {
    const target = join(context.dir, file);
    mkdirSync(dirname(target), { recursive: true });
    const { path: _path, ...rest } = body;
    writeFileSync(target, print(rest as Json));
    written.push(file);
  };

  const projectResponse = await call("GET", `projects/${manifest.project}`);
  if (projectResponse.ok) write("project.cms.json", (await projectResponse.json()) as Json);

  const plurals = new Set(manifest.resources.map((pattern) => pattern.split("/")[0]!));
  for (const plural of plurals) {
    const listed = await call("GET", `projects/${manifest.project}/${plural}?max_page_size=1000`);
    if (!listed.ok) continue;
    const body = (await listed.json()) as { results: (Json & { path: string })[] };
    for (const row of body.results) {
      const slug = row.path.split("/").pop();
      if (formatOf(manifest, plural) === "css") {
        const target = join(context.dir, `${plural}/${slug}.cms.css`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, String(row["css"] ?? ""));
        written.push(`${plural}/${slug}.cms.css`);
      } else {
        write(`${plural}/${slug}.cms.json`, row);
      }
    }
  }
  return { written };
}

/**
 * Reified artifacts (baas/site.md §2): discovery + PWA files written into
 * the STATIC site's public/ from the declared content — sitemap, robots,
 * llms.txt, and the web app manifest (buildManifest over site config +
 * theme tokens), base-path aware for GitHub Pages. Icons/screenshots are
 * referenced, not generated — ship them in public/; the service worker
 * and per-page .md mirrors are the tier's remaining pieces.
 */
export async function artifacts(
  context: SyncContext,
  options: { out: string; base?: string },
): Promise<{ written: string[] }> {
  const { buildManifest, parseThemeCss } = (await import("hono-aep-cms")) as unknown as {
    buildManifest: (site: Json, themes: unknown[], pages: Json[]) => Json;
    parseThemeCss: (name: string, css: string) => unknown;
  };
  const manifest = loadManifest(context.dir);
  const call = api(context, manifest);
  const written: string[] = [];
  const base = (options.base ?? "").replace(/\/$/, "");

  const projectResponse = await call("GET", `projects/${manifest.project}`);
  if (!projectResponse.ok) {
    throw new Error(`GET projects/${manifest.project} → ${projectResponse.status} (artifacts need your sk_ key)`);
  }
  const project = (await projectResponse.json()) as Json & { display_name?: string; site?: Json };
  const site = (project.site ?? {}) as Json;
  const url = String(site["url"] ?? "").replace(/\/$/, "");
  if (!url) {
    throw new Error("artifacts: project.site.url is required (set it in project.cms.json and push)");
  }
  const name = String(site["name"] ?? project.display_name ?? manifest.project);

  const pagesResponse = await call("GET", `projects/${manifest.project}/pages?max_page_size=1000`);
  const pageRows = pagesResponse.ok
    ? ((await pagesResponse.json()) as { results: (Json & { path: string; title: string })[] }).results
    : [];
  const pages = pageRows.map((row) => ({
    slug: row.path.split("/").pop()!,
    title: row.title,
    data: row["data"],
  }));

  const themesResponse = await call("GET", `projects/${manifest.project}/themes?max_page_size=1000`);
  const themeRows = themesResponse.ok
    ? ((await themesResponse.json()) as { results: (Json & { path: string; css: string })[] }).results
    : [];
  const themes = themeRows.map((row) => parseThemeCss(row.path.split("/").pop()!, row.css));

  const write = (file: string, content: string): void => {
    const target = join(options.out, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(file);
  };

  // The web app manifest — installable off a static host (site.md §2a:
  // the base path feeds id/start_url/scope on project pages).
  const webManifest = buildManifest(
    { name, url, locale: String(site["locale"] ?? "en"), description: site["description"], app: site["app"] } as Json,
    themes,
    pages as Json[],
  ) as Json;
  webManifest["id"] = `${base}/`;
  webManifest["start_url"] = `${base}/`;
  webManifest["scope"] = `${base}/`;
  write("manifest.webmanifest", `${JSON.stringify(webManifest, null, 2)}
`);

  const pageUrl = (slug: string): string => `${url}${base}/${slug === "home" ? "" : slug}`;
  const urls = [`${url}${base}/`, ...pages.filter((page) => page.slug !== "home").map((page) => pageUrl(page.slug))];
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
      .map((loc) => `  <url><loc>${loc}</loc></url>`)
      .join("\n")}
</urlset>
`,
  );
  write("robots.txt", `User-agent: *
Allow: /

Sitemap: ${url}${base}/sitemap.xml
`);
  write(
    "llms.txt",
    `# ${name}
${site["description"] ? `
> ${site["description"]}
` : ""}
## Pages
${[
      `- [Home](${url}${base}/)`,
      ...pages.filter((page) => page.slug !== "home").map((page) => `- [${page.title}](${pageUrl(page.slug)})`),
    ].join("\n")}
`,
  );
  return { written };
}

/** Canonical reprint of the local files (the round-trip gate). */
export function fmt(context: SyncContext): { formatted: string[] } {
  const manifest = loadManifest(context.dir);
  const formatted: string[] = [];
  const reprint = (file: string): void => {
    const target = join(context.dir, file);
    try {
      const current = readFileSync(target, "utf8");
      const printed = print(JSON.parse(current) as Json);
      if (printed !== current) {
        writeFileSync(target, printed);
        formatted.push(file);
      }
    } catch {
      // absent file — nothing to format
    }
  };
  reprint("project.cms.json");
  for (const entry of loadFiles(context.dir, manifest)) {
    if (entry.format === "css") continue; // the server canonicalizes; pull reifies
    reprint(entry.file);
  }
  return { formatted };
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [verb] = process.argv.slice(2);
  const dirIndex = process.argv.indexOf("--dir");
  const context: SyncContext = {
    dir: dirIndex >= 0 ? process.argv[dirIndex + 1]! : ".",
    key: process.env.BAAS_KEY ?? "",
    log: console.log,
  };
  if (!context.key && verb !== "fmt") {
    console.error("BAAS_KEY (an sk_ secret key) is required — sync.md §5.");
    process.exit(1);
  }
  switch (verb) {
    case "diff": {
      const plan = await diff(context);
      for (const entry of plan) console.log(`${entry.action.padEnd(6)} ${entry.path}`);
      const drift = plan.filter((entry) => entry.action !== "noop").length;
      console.log(`\n${drift} change(s), ${plan.length - drift} in sync`);
      if (process.argv.includes("--exit-code") && drift > 0) process.exit(2);
      break;
    }
    case "push": {
      const result = await push(context, { prune: process.argv.includes("--prune") });
      console.log(`applied ${result.applied}, pruned ${result.pruned}, unchanged ${result.noops}`);
      break;
    }
    case "pull": {
      const result = await pull(context);
      for (const file of result.written) console.log(`wrote ${file}`);
      break;
    }
    case "artifacts": {
      const outIndex = process.argv.indexOf("--out");
      const baseIndex = process.argv.indexOf("--base");
      if (outIndex < 0) {
        console.error("artifacts requires --out <public-dir> (and optionally --base /repo)");
        process.exit(1);
      }
      const result = await artifacts(context, {
        out: process.argv[outIndex + 1]!,
        ...(baseIndex >= 0 ? { base: process.argv[baseIndex + 1]! } : {}),
      });
      for (const file of result.written) console.log(`wrote ${file}`);
      break;
    }
    case "fmt": {
      const result = fmt(context);
      console.log(result.formatted.length ? result.formatted.join("\n") : "already canonical");
      break;
    }
    default:
      console.error("usage: sync <diff|push|pull|fmt|artifacts> --dir <config-dir> [--prune] [--exit-code] [--out <dir> --base /repo]");
      process.exit(1);
  }
}
