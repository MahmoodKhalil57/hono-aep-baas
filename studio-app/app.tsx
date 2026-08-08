import { useEffect, useMemo, useState } from "react";
import {
  AepUiProvider,
  adminModelFromDocument,
  shadcnKit,
  type AdminModel,
  type Json,
} from "hono-aep-ui";
import { v1 } from "./client";
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

export function StudioRoot() {
  const [user, setUser] = useState<Json | null | "loading">("loading");
  useEffect(() => {
    fetch("/api/auth/get-session")
      .then((response) => response.json())
      .then((session) => setUser((session as { user?: Json } | null)?.user ?? null))
      .catch(() => setUser(null));
  }, []);
  if (user === "loading") return <Shell />;
  if (!user) return <Shell><Gate onSignedIn={setUser} /></Shell>;
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

function Gate({ onSignedIn }: { onSignedIn: (user: Json) => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");
  const submit = async (form: FormData) => {
    const body: Record<string, unknown> = {
      email: form.get("email"),
      password: form.get("password"),
    };
    if (mode === "up") body.name = form.get("name") || body.email;
    const response = await fetch(`/api/auth/sign-${mode === "in" ? "in" : "up"}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return setError("Refused — check the credentials.");
    const session = await (await fetch("/api/auth/get-session")).json();
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
              void fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(onSignOut);
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
