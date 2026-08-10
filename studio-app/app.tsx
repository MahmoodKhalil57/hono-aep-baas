import { useEffect, useMemo, useState } from "react";
import {
  AepUiProvider,
  AutoForm,
  AutoTable,
  adminModelFromDocument,
  shadcnKit,
  type AdminModel,
  type Json,
} from "hono-aep-ui";
import { authFetch, setToken, token, v1 } from "./client";
import { CollectionsTab } from "./collections";
import { ThemesTab } from "./themes";
import { PagesTab } from "./pages-tab";
import { FormsTab, KeysTab, ProjectTab } from "./misc";

/**
 * The dogfooded studio shell: the control plane (projects, collections,
 * themes, pages, forms, …) is itself an AEP surface, so this console is a
 * hono-aep-ui client of /v1/openapi.json — the same machinery any app
 * built ON the baas uses, pointed at the baas's own contract. Cookie auth
 * stays first-party (same origin as /api/auth); one-write-surface holds:
 * everything below speaks the public /v1.
 */

type ProjectRow = { path: string; display_name?: string };
const projectId = (row: ProjectRow) => row.path.split("/")[1] ?? "";

/** Hash routes: #/{tab}[/{id…}] — same convention the studio package uses. */
function useHashRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

const TABS = [
  ["collections", "Collections"],
  ["themes", "Themes"],
  ["pages", "Pages"],
  ["forms", "Forms"],
  ["project", "Project"],
  ["keys", "Keys"],
] as const;

/**
 * The interface context (spec/interface.md): served at
 * /v1/projects/{path}/(studio|admin), the ONE engine targets THAT
 * project (path may be nested, e.g. bastarter/projects/saastarter3) in
 * definition (studio) or data (admin) mode. Served at /studio → the
 * multi-project console (no context).
 */
function interfaceContext(): { projectPath: string; mode: "studio" | "admin" } | null {
  const m = location.pathname.match(/^\/v1\/projects\/(.+?)\/(studio|admin)\/?$/);
  return m ? { projectPath: m[1]!, mode: m[2] as "studio" | "admin" } : null;
}

/**
 * Which auth a project's OWNER uses (spec/interface.md): a nested project
 * `…/{parent}/projects/{child}` is owned by a member of the PARENT's pool,
 * so sign in there; a top-level project is platform-owned (/api/auth).
 * The token is bearer either way (both are bearer-first).
 */
function authBaseFor(projectPath: string | null): string {
  if (!projectPath || !projectPath.includes("/projects/")) return "/api/auth";
  const parent = projectPath.slice(0, projectPath.lastIndexOf("/projects/"));
  return `/v1/projects/${parent}/auth`;
}

export function StudioRoot() {
  const [user, setUser] = useState<Json | null | "loading">("loading");
  const ctx = interfaceContext();
  const authBase = authBaseFor(ctx?.projectPath ?? null);
  useEffect(() => {
    const t = token();
    // An sk_ owner KEY is auth on its own (its stored principal owns the
    // project) — no session to fetch. This is how a NESTED/pool-owned
    // project's owner drives the interface: a bastarter-pool session is
    // foreign to the child, but the child's key carries the owner
    // principal (pool:{parent}:{uid}) directly.
    if (t?.startsWith("sk_")) return void setUser({ key: true });
    (t ? authFetch(`${authBase}/get-session`).then((r) => r.json()) : fetch(`${authBase}/get-session`).then((r) => r.json()))
      .then((s) => setUser((s as { user?: Json } | null)?.user ?? null)).catch(() => setUser(null));
  }, [authBase]);
  if (user === "loading") return <Shell />;
  if (!user) return <Shell><Gate authBase={authBase} onSignedIn={setUser} /></Shell>;
  if (ctx) return <Interface projectPath={ctx.projectPath} mode={ctx.mode} authBase={authBase} onSignOut={() => setUser(null)} />;
  return <Studio onSignOut={() => setUser(null)} />;
}

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <p className="kicker">mizan-gpp</p>
      <h1 className="text-2xl font-semibold tracking-tight">Developer studio</h1>
      {children}
    </main>
  );
}

function Gate({ authBase, onSignedIn }: { authBase: string; onSignedIn: (user: Json) => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");
  const submit = async (form: FormData) => {
    const body: Record<string, unknown> = {
      email: form.get("email"),
      password: form.get("password"),
    };
    if (mode === "up") body.name = form.get("name") || body.email;
    const response = await fetch(`${authBase}/sign-${mode === "in" ? "in" : "up"}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return setError("Refused — check the credentials.");
    // Harvest the bearer token for cross-origin / pool-owned interfaces;
    // same-origin platform sessions carry a cookie too.
    setToken(response.headers.get("set-auth-token"));
    const session = await (await authFetch(`${authBase}/get-session`)).json();
    onSignedIn((session as { user: Json }).user);
  };
  return (
    <form
      className="mx-auto mt-10 flex w-full max-w-sm flex-col gap-3 rounded-lg border bg-card p-6"
      onSubmit={(event) => { event.preventDefault(); void submit(new FormData(event.currentTarget)); }}
    >
      <h2 className="text-lg font-medium">{mode === "in" ? "Sign in" : "Create an account"}</h2>
      {mode === "up" && (
        <input name="name" placeholder="Name" className="rounded-md border bg-background px-3 py-2 text-sm" />
      )}
      <input name="email" type="email" required placeholder="Email" className="rounded-md border bg-background px-3 py-2 text-sm" />
      <input name="password" type="password" required placeholder="Password" className="rounded-md border bg-background px-3 py-2 text-sm" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <button type="submit" className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
        {mode === "in" ? "Sign in" : "Create account"}
      </button>
      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setMode(mode === "in" ? "up" : "in")}
      >
        {mode === "in" ? "Create an account instead" : "Sign in instead"}
      </button>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">Use an owner key (sk_) instead</summary>
        <p className="mt-1 text-xs">A nested/pool-owned project's owner authenticates with its sk_ key.</p>
        <input
          type="password" placeholder="sk_live_…"
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const value = (event.target as HTMLInputElement).value.trim();
            if (value.startsWith("sk_")) { setToken(value); onSignedIn({ key: true }); }
          }}
        />
      </details>
    </form>
  );
}

function Studio({ onSignOut }: { onSignOut: () => void }) {
  const client = v1;
  const [model, setModel] = useState<AdminModel | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [pid, setPid] = useState("");
  const route = useHashRoute();
  const tab = route[0] || "collections";

  useEffect(() => {
    void fetch("/v1/openapi.json")
      .then((response) => response.json())
      .then((doc) => setModel(adminModelFromDocument(doc as Json)));
    void client.list<ProjectRow>("projects").then(({ results }) => {
      setProjects(results);
      setPid((current) => current || (results[0] ? projectId(results[0]) : ""));
    });
  }, [client]);

  const config = useMemo(
    () => ({
      components: shadcnKit(),
      client,
      docUrl: "/v1/openapi.json",
      navigate: (to: string) => { location.hash = to.startsWith("#") ? to.slice(1) : to; },
      linkHref: (to: string) => (to.startsWith("#") ? to : `#${to}`),
    }),
    [client],
  );

  const createProject = async () => {
    const name = prompt("New project name?");
    if (!name) return;
    const created = await client.create<ProjectRow>("projects", { display_name: name });
    setProjects((rows) => [...rows, created]);
    setPid(projectId(created));
  };

  return (
    <AepUiProvider config={config}>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <p className="kicker">mizan-gpp</p>
            <h1 className="text-xl font-semibold tracking-tight">Developer studio</h1>
          </div>
          <select
            value={pid}
            onChange={(event) => setPid(event.target.value)}
            className="rounded-md border bg-card px-2 py-1.5 text-sm"
          >
            {projects.map((row) => (
              <option key={row.path} value={projectId(row)}>
                {row.display_name ?? row.path} ({projectId(row).slice(0, 8)}…)
              </option>
            ))}
          </select>
          <button onClick={() => void createProject()} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
            New project
          </button>
          <button
            onClick={() => {
              void authFetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).finally(() => { setToken(null); onSignOut(); });
            }}
            className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            Sign out
          </button>
        </div>
        <nav className="mb-5 flex gap-1 border-b">
          {TABS.map(([key, label]) => (
            <a
              key={key}
              href={`#/${key}`}
              className={`rounded-t-md px-3 py-2 text-sm ${tab === key ? "border border-b-0 bg-card font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </a>
          ))}
        </nav>
        {!model || !pid ? (
          <p className="text-sm text-muted-foreground">
            {model ? "No projects yet — create one to begin." : "Loading the /v1 contract…"}
          </p>
        ) : (
          <>
            {tab === "collections" && <CollectionsTab model={model} pid={pid} slug={route[1]} />}
            {tab === "themes" && <ThemesTab pid={pid} slug={route[1]} />}
            {tab === "pages" && <PagesTab pid={pid} slug={route[1]} />}
            {tab === "forms" && <FormsTab model={model} pid={pid} id={route[1]} />}
            {tab === "project" && <ProjectTab model={model} pid={pid} />}
            {tab === "keys" && <KeysTab pid={pid} />}
          </>
        )}
      </main>
    </AepUiProvider>
  );
}

/**
 * The unified per-project interface (spec/interface.md): the SAME engine,
 * pointed at one project (nested path ok) in studio (definition plane) or
 * admin (data plane) mode. `pid` is the whole project path, so nested
 * children route through the API rewrite for free.
 */
const STUDIO_TABS = [
  ["collections", "Collections"], ["themes", "Themes"], ["pages", "Pages"],
  ["forms", "Forms"], ["project", "Project"], ["keys", "Keys"],
] as const;

function Interface({ projectPath, mode, authBase, onSignOut }: { projectPath: string; mode: "studio" | "admin"; authBase: string; onSignOut: () => void }) {
  const client = v1;
  const [model, setModel] = useState<AdminModel | null>(null);
  const route = useHashRoute();

  // studio → the control-plane contract (collections/themes/… as resources);
  // admin → THIS project's contract (products/orders as resources).
  const docUrl = mode === "studio" ? "/v1/openapi.json" : `/v1/projects/${projectPath}/openapi.json`;
  useEffect(() => {
    void fetch(docUrl).then((r) => r.json()).then((doc) => setModel(adminModelFromDocument(doc as Json)));
  }, [docUrl]);

  const config = useMemo(
    () => ({
      components: shadcnKit(), client, docUrl,
      navigate: (to: string) => { location.hash = to.startsWith("#") ? to.slice(1) : to; },
      linkHref: (to: string) => (to.startsWith("#") ? to : `#${to}`),
    }),
    [client, docUrl],
  );

  const header = (
    <div className="mb-5 flex flex-wrap items-center gap-3 border-b pb-3">
      <div className="mr-auto">
        <p className="kicker">{projectPath}</p>
        <h1 className="text-xl font-semibold tracking-tight capitalize">{mode}</h1>
      </div>
      <a href={mode === "studio" ? `/v1/projects/${projectPath}/admin` : `/v1/projects/${projectPath}/studio`}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
        {mode === "studio" ? "Open admin →" : "Open studio →"}
      </a>
      <button
        onClick={() => void authFetch(`${authBase}/sign-out`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).finally(() => { setToken(null); onSignOut(); })}
        className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent">Sign out</button>
    </div>
  );

  if (!model) return <Shell><p className="text-sm text-muted-foreground">Loading the contract…</p></Shell>;

  return (
    <AepUiProvider config={config}>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {header}
        {mode === "studio" ? (
          <StudioTabs pid={projectPath} model={model} route={route} />
        ) : (
          <AdminView projectPath={projectPath} model={model} />
        )}
      </main>
    </AepUiProvider>
  );
}

function StudioTabs({ pid, model, route }: { pid: string; model: AdminModel; route: string[] }) {
  const tab = route[0] || "collections";
  return (
    <>
      <nav className="mb-5 flex gap-1 border-b">
        {STUDIO_TABS.map(([key, label]) => (
          <a key={key} href={`#/${key}`}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === key ? "border border-b-0 bg-card font-medium" : "text-muted-foreground hover:text-foreground"}`}>{label}</a>
        ))}
      </nav>
      {tab === "collections" && <CollectionsTab model={model} pid={pid} slug={route[1]} />}
      {tab === "themes" && <ThemesTab pid={pid} slug={route[1]} />}
      {tab === "pages" && <PagesTab pid={pid} slug={route[1]} />}
      {tab === "forms" && <FormsTab model={model} pid={pid} id={route[1]} />}
      {tab === "project" && <ProjectTab model={model} pid={pid} />}
      {tab === "keys" && <KeysTab pid={pid} />}
    </>
  );
}

/** Admin (data plane): AutoTable/AutoForm over the collections named by
 * site.admin — the same contract-driven admin as the no-build renderer,
 * in the one React engine. */
function AdminView({ projectPath, model }: { projectPath: string; model: AdminModel }) {
  const [admin, setAdmin] = useState<{ collections?: (string | { slug: string })[] } | null>(null);
  const route = useHashRoute();
  useEffect(() => {
    void v1.get<Json>(`projects/${projectPath}`).then((doc) => {
      setAdmin(((doc as { site?: { admin?: { collections?: (string | { slug: string })[] } } }).site?.admin) ?? { collections: [] });
    });
  }, [projectPath]);
  if (!admin) return <p className="text-sm text-muted-foreground">Loading admin config…</p>;
  const slugs = (admin.collections ?? []).map((c) => (typeof c === "string" ? c : c.slug));
  const active = route[0] && slugs.includes(route[0]) ? route[0] : slugs[0];
  if (!slugs.length) return <p className="text-sm text-muted-foreground">No admin collections configured (site.admin.collections).</p>;
  const resource = active ? model.byPlural(active) : null;
  return (
    <>
      <nav className="mb-5 flex gap-1 border-b">
        {slugs.map((slug) => (
          <a key={slug} href={`#/${slug}`}
            className={`rounded-t-md px-3 py-2 text-sm capitalize ${active === slug ? "border border-b-0 bg-card font-medium" : "text-muted-foreground hover:text-foreground"}`}>{slug}</a>
        ))}
      </nav>
      {resource ? (
        <div className="flex flex-col gap-4">
          <AutoTable resource={resource} collection={`projects/${projectPath}/${active}`} basePath={`#/${active}`} />
          {route[1] === "new" && (
            <AutoForm resource={resource} mode="create" collection={`projects/${projectPath}/${active}`} onSaved={() => { location.hash = `/${active}`; }} />
          )}
        </div>
      ) : (
        <p className="text-sm text-destructive">Collection “{active}” is not in this project's contract.</p>
      )}
    </>
  );
}
