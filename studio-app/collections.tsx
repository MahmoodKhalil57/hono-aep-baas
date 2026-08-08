import { useEffect, useState } from "react";
import { AutoTable, AutoForm, type AdminModel, type Json } from "hono-aep-ui";
import { v1 as client } from "./client";
import { LintPanel } from "hono-aep-studio/src/lint";

/**
 * Collections, rendered from the control plane's own x-aep-ui metadata:
 * AutoTable lists them, AutoForm edits the row (the `definition` field
 * carries widget:"json", so the kit's code editor renders it), and the
 * studio package's AEP LintPanel audits the applied document. Same public
 * PUT/PATCH bodies as every other client.
 */

type CollectionRow = { path: string; definition?: Json };
const slugOf = (row: CollectionRow) => row.path.split("/").pop() ?? "";

export function CollectionsTab({ model, pid, slug }: { model: AdminModel; pid: string; slug?: string }) {
  const resource = model.byPlural("collections");
  if (!resource) return <p className="text-sm text-destructive">The contract exposes no collections resource.</p>;
  if (slug === "new") return <CreateCollection pid={pid} />;
  if (slug) return <EditCollection model={model} pid={pid} slug={slug} />;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">JIT resource definitions — applied documents are live immediately.</p>
        <a href="#/collections/new" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
          New collection
        </a>
      </div>
      <AutoTable resource={resource} collection={`projects/${pid}/collections`} basePath="#/collections" />
    </section>
  );
}

function EditCollection({ model, pid, slug }: { model: AdminModel; pid: string; slug: string }) {
  const resource = model.byPlural("collections")!;
  const [row, setRow] = useState<CollectionRow | null>(null);
  const [siblings, setSiblings] = useState<string[]>([]);
  useEffect(() => {
    setRow(null);
    void client.get<CollectionRow>(`projects/${pid}/collections/${slug}`).then(setRow);
    void client
      .list<CollectionRow>(`projects/${pid}/collections`)
      .then(({ results }) => setSiblings(results.map(slugOf)));
  }, [client, pid, slug]);
  if (!row) return <p className="text-sm text-muted-foreground">Loading {slug}…</p>;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm">collections/{slug}</h2>
        <div className="flex gap-2">
          <a href="#/collections" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Back</a>
          <button
            className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground"
            onClick={() => {
              if (!confirm(`Delete collections/${slug}? Its rows become unreachable.`)) return;
              void client.delete(`projects/${pid}/collections/${slug}`).then(() => { location.hash = "/collections"; });
            }}
          >
            Delete
          </button>
        </div>
      </div>
      <AutoForm
        resource={resource}
        mode="edit"
        collection={`projects/${pid}/collections/${slug}`}
        initial={row as unknown as Json}
        onSaved={(saved) => setRow(saved as unknown as CollectionRow)}
      />
      {row.definition ? (
        <div className="rounded-lg border bg-card p-4">
          <p className="kicker mb-2">aep lint</p>
          <LintPanel row={row.definition} collections={siblings} />
        </div>
      ) : null}
    </section>
  );
}

function CreateCollection({ pid }: { pid: string }) {
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState(() =>
    JSON.stringify(
      {
        singular: "thing",
        plural: "things",
        fields: [{ name: "title", type: "string", required: true }],
        policy_create: "authenticated",
        policy_list: "public",
        policy_get: "public",
      },
      null,
      2,
    ),
  );
  const [error, setError] = useState("");
  const apply = async () => {
    try {
      await client.apply(`projects/${pid}/collections/${slug}`, { definition: JSON.parse(body) });
      location.hash = `/collections/${slug}`;
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Refused");
    }
  };
  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <h2 className="text-lg font-medium">New collection</h2>
      <input
        value={slug}
        onChange={(event) => setSlug(event.target.value)}
        placeholder="slug (kebab-case)"
        className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={14}
        spellCheck={false}
        className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button onClick={() => void apply()} disabled={!slug} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
          Apply definition
        </button>
        <a href="#/collections" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Cancel</a>
      </div>
    </section>
  );
}
