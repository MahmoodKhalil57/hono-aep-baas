import { useMemo, useState } from "react";


/**
 * The visual builder for a JIT collection definition — the React
 * successor of /studio-lite's field-row builder, with two upgrades the
 * vanilla one couldn't afford: UNKNOWN KEYS ARE PRESERVED (per-field
 * attrs like reference/default and top-level keys like states/
 * transitions round-trip verbatim; the builder only patches what its
 * controls own), and both modes edit the same draft object so the
 * caller lints it live and Applies it as a full-replace PUT.
 */

type Definition = Record<string, unknown>;
type FieldRow = Record<string, unknown> & { name?: string };

const TYPES = ["string", "integer", "number", "boolean", "date", "datetime", "object", "any"] as const;
const FLAGS = ["required", "unique", "indexed", "localized"] as const;
const VERBS = ["create", "list", "get", "update", "delete"] as const;
/** Top-level keys the visual controls own; everything else is preserved. */
const OWNED = new Set(["singular", "plural", "fields", "owner", ...VERBS.map((verb) => `policy_${verb}`)]);
/** Per-field keys the row controls own. */
const ROW_OWNED = new Set(["name", "type", "integer", ...FLAGS, "enum_values"]);

const typeOf = (field: FieldRow): string =>
  field.integer ? "integer" : typeof field.type === "string" ? field.type : "string";

function setType(field: FieldRow, type: string): FieldRow {
  const next = { ...field };
  if (type === "integer") { next.type = "number"; next.integer = true; }
  else { next.type = type; delete next.integer; }
  return next;
}

type PolicyKind = "" | "public" | "authenticated" | "owner" | "custom";
function policyKind(policy: unknown): PolicyKind {
  if (policy === undefined) return "";
  if (policy === "public" || policy === "authenticated") return policy;
  if (typeof policy === "object" && policy !== null && "owner" in policy) return "owner";
  return "custom";
}

export function DefinitionEditor({
  value,
  onChange,
}: {
  value: Definition;
  onChange: (next: Definition) => void;
}) {
  const [visual, setVisual] = useState(true);
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState("");
  const fields = useMemo(() => (Array.isArray(value.fields) ? (value.fields as FieldRow[]) : []), [value]);
  const preserved = Object.keys(value).filter((key) => !OWNED.has(key));

  const patch = (partial: Definition) => onChange({ ...value, ...partial });
  const patchField = (at: number, next: FieldRow) =>
    patch({ fields: fields.map((field, index) => (index === at ? next : field)) });

  const setPolicy = (verb: string, kind: PolicyKind) => {
    const next = { ...value };
    if (kind === "") delete next[`policy_${verb}`];
    else if (kind === "owner") next[`policy_${verb}`] = { owner: { field: "created_by" } };
    else if (kind !== "custom") next[`policy_${verb}`] = kind;
    // An owner policy needs the binding + the field — the classic footgun,
    // guarded here exactly as the vanilla builder does.
    const usesOwner = VERBS.some((v) => policyKind(next[`policy_${v}`]) === "owner");
    if (usesOwner) {
      next.owner = typeof next.owner === "string" ? next.owner : "created_by";
      const rows = Array.isArray(next.fields) ? ([...(next.fields as FieldRow[])] as FieldRow[]) : [];
      if (!rows.some((field) => field.name === "created_by")) rows.push({ name: "created_by", type: "string" });
      next.fields = rows;
    }
    onChange(next);
  };

  const toggle = (
    <div className="flex gap-1 rounded-md border p-0.5 text-sm">
      {(["Visual", "JSON"] as const).map((label) => (
        <button
          key={label}
          type="button"
          className={`rounded px-2 py-1 ${visual === (label === "Visual") ? "bg-accent font-medium" : "text-muted-foreground"}`}
          onClick={() => {
            if (label === "JSON") { setJsonDraft(JSON.stringify(value, null, 2)); setJsonError(""); }
            setVisual(label === "Visual");
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (!visual) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">The raw definition document — full control.</p>
          {toggle}
        </div>
        <textarea
          value={jsonDraft ?? JSON.stringify(value, null, 2)}
          rows={20}
          spellCheck={false}
          className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
          onChange={(event) => {
            setJsonDraft(event.target.value);
            try { onChange(JSON.parse(event.target.value) as Definition); setJsonError(""); }
            catch { setJsonError("Invalid JSON — the draft keeps the last valid state."); }
          }}
        />
        {jsonError && <p className="text-sm text-destructive">{jsonError}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <input
            value={String(value.singular ?? "")}
            onChange={(event) => patch({ singular: event.target.value })}
            placeholder="singular"
            className="rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
          />
          <input
            value={String(value.plural ?? "")}
            onChange={(event) => patch({ plural: event.target.value })}
            placeholder="plural"
            className="rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
          />
        </div>
        {toggle}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {VERBS.map((verb) => {
          const kind = policyKind(value[`policy_${verb}`]);
          return (
            <label key={verb} className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{verb}</span>
              <select
                value={kind}
                onChange={(event) => setPolicy(verb, event.target.value as PolicyKind)}
                className="rounded-md border bg-card px-1.5 py-1"
              >
                <option value="">—</option>
                <option value="public">public</option>
                <option value="authenticated">authenticated</option>
                <option value="owner">owner</option>
                {kind === "custom" && <option value="custom">custom (JSON)</option>}
              </select>
            </label>
          );
        })}
      </div>

      <div className="flex flex-col divide-y rounded-lg border bg-card">
        {fields.map((field, at) => {
          const extras = Object.keys(field).filter((key) => !ROW_OWNED.has(key));
          return (
            <div key={at} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <input
                value={String(field.name ?? "")}
                onChange={(event) => patchField(at, { ...field, name: event.target.value })}
                placeholder="field name"
                className="w-40 rounded-md border bg-background px-2 py-1 font-mono text-sm"
              />
              <select
                value={typeOf(field)}
                onChange={(event) => patchField(at, setType(field, event.target.value))}
                className="rounded-md border bg-background px-1.5 py-1 text-sm"
              >
                {TYPES.map((type) => <option key={type}>{type}</option>)}
              </select>
              {FLAGS.map((flag) => (
                <label key={flag} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={Boolean(field[flag])}
                    onChange={(event) => {
                      const next = { ...field };
                      if (event.target.checked) next[flag] = true;
                      else delete next[flag];
                      patchField(at, next);
                    }}
                  />
                  {flag}
                </label>
              ))}
              <input
                value={Array.isArray(field.enum_values) ? (field.enum_values as string[]).join(",") : ""}
                onChange={(event) => {
                  const values = event.target.value.split(",").map((part) => part.trim()).filter(Boolean);
                  const next = { ...field };
                  if (values.length) next.enum_values = values;
                  else delete next.enum_values;
                  patchField(at, next);
                }}
                placeholder="enum: a,b,c"
                className="w-44 rounded-md border bg-background px-2 py-1 font-mono text-xs"
              />
              {extras.length > 0 && (
                <span className="text-xs text-muted-foreground" title={extras.join(", ")}>
                  +{extras.length} attr{extras.length > 1 ? "s" : ""} (JSON)
                </span>
              )}
              <button
                type="button"
                className="ml-auto text-xs text-destructive hover:underline"
                onClick={() => patch({ fields: fields.filter((_, index) => index !== at) })}
              >
                remove
              </button>
            </div>
          );
        })}
        {!fields.length && <p className="px-3 py-2 text-sm text-muted-foreground">No fields yet.</p>}
      </div>
      <div>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          onClick={() => patch({ fields: [...fields, { name: "", type: "string" }] })}
        >
          Add field
        </button>
      </div>

      {preserved.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Preserved verbatim (edit in JSON mode): {preserved.join(", ")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        An "owner" policy auto-adds the created_by field + owner binding.
      </p>
    </div>
  );
}
