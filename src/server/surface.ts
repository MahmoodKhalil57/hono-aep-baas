import { Hono } from "hono";
import { aepApp, attachMcp, type AepApp } from "hono-aep";
import { jsonRowsStorage } from "hono-aep-drizzle";
import { db } from "../db/registry";
import { jitProjectApp, type JitProject } from "./jit-collections";
import { block, collection, domain, form, page, submission, theme } from "./resources";

/**
 * The project SURFACE (surface.md): one resource model spanning both planes,
 * projected for agents at `{BASE}/mcp`.
 *
 * A project's capabilities live in two places — the DEFINITION plane
 * (collections, themes, pages, forms, blocks: compiled resources parked
 * under /projects/{p}/…) and the DATA plane (the project's JIT collections'
 * rows). The studio edits one, the admin edits the other, and an agent must
 * reach BOTH through a single endpoint: that is what lets it declare a
 * collection and immediately write rows into it.
 *
 * So the surface is a composite router presenting both planes as ONE flat
 * collection namespace, with the suite's contract-generated MCP bridge over
 * it. Nothing here knows about nesting: the caller-visible base is handled
 * by the ancestor chain upstream (surface.md §1.1), so this same surface
 * serves /v1/projects/{p}/mcp and any nested depth unchanged.
 */

/** Definition-plane resources whose parent is the project itself. */
const DEFINITION_PLURALS = new Set(["collections", "domains", "themes", "pages", "forms", "blocks"]);

/**
 * Within a surface these are ROOT collections (`/collections`), not children
 * of `projects` — the project IS the surface, so its own id is not part of
 * the addressing. `submissions` keeps its `forms` parent: that nesting is
 * real inside the surface.
 */
const DEFINITION_RESOURCES = (() => {
  const rootless = <T extends object>(resource: T): T => {
    const { parent: _parent, ...rest } = resource as T & { parent?: unknown };
    return rest as T;
  };
  return [
    rootless(collection),
    rootless(domain),
    rootless(theme),
    rootless(page),
    rootless(form),
    rootless(block),
    submission,
  ];
})();

/**
 * Cached per project, keyed on the JIT app's IDENTITY: `invalidateProject`
 * drops the JIT cache, so the next build yields a fresh instance and the
 * surface rebuilds with it. No second invalidation path to keep in sync.
 *
 * The cache also preserves the bridge's ETag memory across calls, which is
 * what makes the AEP-154 read-then-write guard (If-Match) meaningful.
 */
const cache = new Map<string, { jit: JitProject | null; built: ProjectSurface }>();

export type ProjectSurface = {
  /** The dispatching surface: both planes, with the MCP bridge mounted. */
  mcp: AepApp;
  /**
   * The DOCUMENTATION projection (surface.md §2). `openApiDocument`
   * introspects registered routes, and the dispatching surface reaches its
   * definition plane by proxy (no routes of its own), so the contract is
   * generated from a parallel app carrying both resource sets.
   *
   * It is never dispatched — which is also why it is safe for its
   * definition resources to be root-level here: stripping their `projects`
   * parent is right for DOCUMENTING `{BASE}/collections`, but would drop the
   * parent scoping that keeps one project's definitions off another's.
   */
  contract: AepApp;
};

export async function projectSurfaceApp(
  projectId: string,
  root: AepApp,
): Promise<ProjectSurface | null> {
  // A project with NO collections still has a surface. Requiring the JIT
  // app here would mean the definition plane — the very place a collection
  // is declared — is unreachable until a collection already exists, so an
  // agent could never create the first one. The data plane is simply empty.
  const jit = await jitProjectApp(projectId);
  const cached = cache.get(projectId);
  if (cached && cached.jit === jit) return cached.built;

  const app = new Hono();

  // Definition plane → the compiled surface, re-prefixed with the project.
  for (const plural of DEFINITION_PLURALS) {
    const forward = async (c: import("hono").Context): Promise<Response> => {
      const url = new URL(c.req.url);
      url.pathname = `/projects/${projectId}${url.pathname}`;
      return await root.app.fetch(new Request(url, c.req.raw));
    };
    app.all(`/${plural}`, forward);
    app.all(`/${plural}/*`, forward);
  }

  const dataStorage = jit?.storage ?? jsonRowsStorage({ db, scope: `projects/${projectId}` });
  const surface = {
    app,
    options: {
      ...(jit?.options ?? {}),
      // Definitions first: an agent orienting itself meets the shaping
      // resources before the rows they shape.
      resources: [...DEFINITION_RESOURCES, ...(jit?.options.resources ?? [])],
    },
    storage: dataStorage,
  } as unknown as AepApp;

  // Registered BEFORE the catch-all so /mcp is not swallowed by it.
  attachMcp(surface, {
    name: `projects/${projectId}`,
    path: "/mcp",
    planeOf: (resource) => (DEFINITION_PLURALS.has(resource.plural) ? "definition" : "data"),
    instructions:
      "This is one project's whole surface. `plane: \"definition\"` collections shape the " +
      "project (the studio's plane: collections, themes, pages, forms); `plane: \"data\"` " +
      "collections hold its rows (the admin's and the frontend's plane). Declaring a " +
      "collection makes its data collection live immediately — no deploy.",
  });

  // Data plane → the project's JIT collections.
  // No collections declared yet → the data plane is empty, not broken.
  app.all("*", async (c) => (jit ? await jit.app.fetch(c.req.raw) : c.json({ title: "No collections declared." }, 404)));

  const contract = aepApp({
    resources: surface.options.resources,
    storage: dataStorage,
    serviceName: jit?.options.serviceName ?? "baas.hono-aep.dev",
    basePath: `/v1/projects/${projectId}`,
  });

  const built: ProjectSurface = { mcp: surface, contract };
  cache.set(projectId, { jit, built });
  return built;
}
