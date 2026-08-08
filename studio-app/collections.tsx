import { useEffect, useState } from "react";
import { AutoTable, type AdminModel } from "hono-aep-ui";
import { v1 as client } from "./client";
import { LintPanel } from "hono-aep-studio/src/lint";
import { DefinitionEditor } from "./definition-editor";

/**
 * Collections: AutoTable lists them from the control plane's own x-aep-ui
 * metadata; the definition itself is edited in the visual builder
 * (definition-editor.tsx, Visual ⇄ JSON) with the studio package's AEP
 * LintPanel auditing the LIVE draft. Apply is a full-replace PUT
 * (client.apply) — correct delete-a-policy semantics, unlike merge-patch.
 */

type CollectionRow = { path: string; definition?: Record<string, unknown> };
const slugOf = (row: CollectionRow) => row.path.split("/").pop() ?? "";

const TEMPLATE: Record<string, unknown> = {
  singular: "thing",
  plural: "things",
  fields: [{ name: "title", type: "string", required: true }],
  policy_create: "authenticated",
  policy_list: "public",
  policy_get: "public",
};

export function CollectionsTab({ model, pid, slug }: { model: AdminModel; pid: string; slug?: string }) {
  const resource = model.byPlural("collections");
  if (!resource) return <p className="text-sm text-destructive">The contract exposes no collections resource.</p>;
  if (slug === "new") return <CollectionEditor pid={pid} />;
  if (slug) return <CollectionEditor pid={pid} slug={slug} />;
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

/** One editor for both create (no slug prop) and edit. */
function CollectionEditor({ pid, slug }: { pid: string; slug?: string }) {
  const creating = !slug;
  const [name, setName] = useState(slug ?? "");
  const [draft, setDraft] = useState<Record<string, unknown> | null>(creating ? TEMPLATE : null);
  const [siblings, setSiblings] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void client
      .list<CollectionRow>(`projects/${pid}/collections`)
      .then(({ results }) => setSiblings(results.map(slugOf)));
    if (!slug) return;
    setDraft(null);
    void client.get<CollectionRow>(`projects/${pid}/collections/${slug}`).then((row) => setDraft(row.definition ?? {}));
  }, [pid, slug]);

  if (!draft) return <p className="text-sm text-muted-foreground">Loading {slug}…</p>;

  const apply = () =>
    void client.apply(`projects/${pid}/collections/${name}`, { definition: draft }).then(
      () => {
        setFailed(false);
        setNote("Definition applied — live immediately.");
        if (creating) location.hash = `/collections/${name}`;
      },
      (thrown: unknown) => {
        setFailed(true);
        setNote(thrown instanceof Error ? thrown.message : "Refused");
      },
    );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        {creating ? (
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="slug (kebab-case)"
            className="rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
          />
        ) : (
          <h2 className="font-mono text-sm">collections/{slug}</h2>
        )}
        <div className="flex gap-2">
          <a href="#/collections" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Back</a>
          {!creating && (
            <button
              className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground"
              onClick={() => {
                if (!confirm(`Delete collections/${slug}? Its rows become unreachable.`)) return;
                void client.delete(`projects/${pid}/collections/${slug}`).then(() => { location.hash = "/collections"; });
              }}
            >
              Delete
            </button>
          )}
          <button
            onClick={apply}
            disabled={!name}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Apply definition
          </button>
        </div>
      </div>
      {note && <p className={`text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}>{note}</p>}
      <DefinitionEditor value={draft} onChange={setDraft} />
      <div className="rounded-lg border bg-card p-4">
        <p className="kicker mb-2">aep lint</p>
        <LintPanel row={draft} collections={siblings.filter((sibling) => sibling !== name)} />
      </div>
    </section>
  );
}
