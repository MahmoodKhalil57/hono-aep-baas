import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { v1 as client } from "./client";
import { aepClient } from "hono-aep/client";

/**
 * Pages, edited with the REAL cms Puck editor (hono-aep-studio's lazy
 * chunk) pointed at the baas public API: the editor's DevClient contract
 * is get/apply, and a project-scoped aepClient satisfies it — get reads
 * pages/{slug}, Publish PUTs it back with If-Match. Genuine dogfooding:
 * the same editor richPetShop's /developer uses, no /developer-api needed.
 */
const PuckEditorPage = lazy(() => import("hono-aep-studio/src/puck-editor"));

type PageRow = { path: string; title?: string };

export function PagesTab({ pid, slug }: { pid: string; slug?: string }) {
  const [pages, setPages] = useState<PageRow[]>([]);
  useEffect(() => {
    void client.list<PageRow>(`projects/${pid}/pages`).then(({ results }) => setPages(results));
  }, [client, pid, slug]);
  if (slug) return <PageEditor pid={pid} slug={slug} />;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Page documents (slug or slug@locale) — edited with the Puck canvas.</p>
        <button
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          onClick={() => {
            const name = prompt("New page slug (or slug@locale)?");
            if (!name) return;
            void client
              .apply(`projects/${pid}/pages/${name}`, { title: "New page", data: { root: { props: {} }, content: [] } })
              .then(() => { location.hash = `/pages/${name}`; });
          }}
        >
          New page
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {pages.map((page) => {
          const name = page.path.split("/").pop()!;
          return (
            <li key={page.path}>
              <a href={`#/pages/${name}`} className="flex items-baseline justify-between rounded-lg border bg-card px-4 py-3 text-sm hover:bg-accent">
                <span className="font-mono">{name}</span>
                <span className="text-muted-foreground">{page.title ?? ""}</span>
              </a>
            </li>
          );
        })}
        {!pages.length && <p className="text-sm text-muted-foreground">No pages yet.</p>}
      </ul>
    </section>
  );
}

function PageEditor({ pid, slug }: { pid: string; slug: string }) {
  const projectClient = useMemo(() => aepClient({ base: `/v1/projects/${pid}` }), [pid]);
  const [note, setNote] = useState("");
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <a href="#/pages" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Back to pages</a>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading the Puck editor…</p>}>
        <PuckEditorPage slug={slug} client={projectClient} onSaved={setNote} />
      </Suspense>
    </section>
  );
}
