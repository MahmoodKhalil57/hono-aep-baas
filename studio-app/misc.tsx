import { useEffect, useState } from "react";
import { AutoTable, AutoForm, type AdminModel, type Json } from "hono-aep-ui";
import { v1 as client } from "./client";

/**
 * The remaining definition-plane tabs, rendered straight from the
 * contract: forms (+ per-form submissions), the project document, and
 * key minting (the keys:mint custom method via client.call).
 */

export function FormsTab({ model, pid, id }: { model: AdminModel; pid: string; id?: string }) {
  const forms = model.byPlural("forms");
  if (!forms) return <p className="text-sm text-destructive">The contract exposes no forms resource.</p>;
  if (id === "new") return <NewForm model={model} pid={pid} />;
  if (id) return <FormDetail model={model} pid={pid} id={id} />;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Forms-as-a-service — each form exposes a pk_ submit key.</p>
        <a href="#/forms/new" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
          New form
        </a>
      </div>
      <AutoTable resource={forms} collection={`projects/${pid}/forms`} basePath="#/forms" />
    </section>
  );
}

function NewForm({ model, pid }: { model: AdminModel; pid: string }) {
  const forms = model.byPlural("forms")!;
  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">New form</h2>
        <a href="#/forms" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Cancel</a>
      </div>
      <AutoForm
        resource={forms}
        mode="create"
        collection={`projects/${pid}/forms`}
        onSaved={(saved) => {
          const formId = String((saved as { path?: string }).path ?? "").split("/").pop();
          location.hash = formId ? `/forms/${formId}` : "/forms";
        }}
      />
    </section>
  );
}

function FormDetail({ model, pid, id }: { model: AdminModel; pid: string; id: string }) {
  const forms = model.byPlural("forms")!;
  const submissions = model.byPlural("submissions");
  const [row, setRow] = useState<Json | null>(null);
  useEffect(() => {
    setRow(null);
    void client.get<Json>(`projects/${pid}/forms/${id}`).then(setRow);
  }, [client, pid, id]);
  if (!row) return <p className="text-sm text-muted-foreground">Loading form…</p>;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm">forms/{id}</h2>
        <a href="#/forms" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Back</a>
      </div>
      <AutoForm
        resource={forms}
        mode="edit"
        collection={`projects/${pid}/forms/${id}`}
        initial={row}
        onSaved={setRow}
      />
      {submissions && (
        <div className="rounded-lg border bg-card p-4">
          <p className="kicker mb-3">submissions</p>
          <AutoTable resource={submissions} collection={`projects/${pid}/forms/${id}/submissions`} basePath="#" />
        </div>
      )}
    </section>
  );
}

export function ProjectTab({ model, pid }: { model: AdminModel; pid: string }) {
  const projects = model.byPlural("projects")!;
  const [row, setRow] = useState<Json | null>(null);
  useEffect(() => {
    setRow(null);
    void client.get<Json>(`projects/${pid}`).then(setRow);
  }, [client, pid]);
  if (!row) return <p className="text-sm text-muted-foreground">Loading the project document…</p>;
  return (
    <section className="flex max-w-3xl flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        The project document (auth_pool, site.locales, …) — saved through the public PATCH.
      </p>
      <AutoForm resource={projects} mode="edit" collection={`projects/${pid}`} initial={row} onSaved={setRow} />
    </section>
  );
}

function SecretsPanel({ pid }: { pid: string }) {
  type Row = { name: string; digest: string };
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const refresh = () => void client.list<Row>(`projects/${pid}/secrets`).then(({ results }) => setRows(results));
  useEffect(refresh, [pid]);
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="kicker mb-1">secrets</p>
      <p className="text-sm text-muted-foreground">
        Per-project secrets (spec/secrets.md) — write-only; auth pools and the payment gateway resolve
        EnvRefs here first. Set STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY to take payments into YOUR Stripe.
      </p>
      <ul className="my-2 flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center gap-3 text-sm">
            <code>{row.name}</code>
            <span className="text-xs text-muted-foreground">sha256:{row.digest}</span>
            <button
              className="text-xs text-destructive hover:underline"
              onClick={() => {
                if (!confirm(`Delete secret ${row.name}?`)) return;
                void client.delete(`projects/${pid}/secrets/${row.name}`).then(refresh);
              }}
            >
              delete
            </button>
          </li>
        ))}
        {!rows.length && <li className="text-sm text-muted-foreground">None yet.</li>}
      </ul>
      <div className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="NAME"
          className="w-56 rounded-md border bg-background px-2 py-1 font-mono text-sm" />
        <input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="value (write-only)"
          className="w-64 rounded-md border bg-background px-2 py-1 font-mono text-sm" />
        <button
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={!name || !value}
          onClick={() => {
            setNote("");
            void client.apply(`projects/${pid}/secrets/${name}`, { value }).then(
              () => { setName(""); setValue(""); refresh(); },
              (thrown: unknown) => setNote(thrown instanceof Error ? thrown.message : "Refused"),
            );
          }}
        >
          Set secret
        </button>
      </div>
      {note && <p className="mt-1 text-sm text-destructive">{note}</p>}
    </div>
  );
}

export function KeysTab({ pid }: { pid: string }) {
  const [minted, setMinted] = useState("");
  const [error, setError] = useState("");
  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Mint an sk_ secret key (sync, seed, MCP, the app admin). Shown once — store it safely.
      </p>
      <div>
        <button
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          onClick={() => {
            setError("");
            void client
              .call<{ plaintext: string }>(`projects/${pid}/keys`, "mint")
              .then(({ plaintext }) => setMinted(plaintext))
              .catch((thrown: unknown) => setError(thrown instanceof Error ? thrown.message : "Refused"));
          }}
        >
          Mint sk_ key
        </button>
      </div>
      {minted && <code className="block break-all rounded-md border bg-card p-3 text-xs">{minted}</code>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">
        Contract: <a className="underline underline-offset-2" href={`/v1/projects/${pid}/openapi.json`}>openapi.json</a>
        {" · "}MCP: <code className="text-xs">{`${location.origin}/v1/projects/${pid}/mcp`}</code>
      </p>
      <SecretsPanel pid={pid} />
    </section>
  );
}
