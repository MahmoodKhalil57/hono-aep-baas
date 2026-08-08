/**
 * The hosted DEVELOPER studio (baas/product §1b's "website" writer) —
 * served from the worker origin at /studio, so the builder session cookie
 * is first-party: plain sign-in, no bearer bridges. Definition-plane
 * only: projects, collection definitions, themes, pages, forms, keys.
 * Application-plane admin (products/orders) belongs to each consumer app.
 * Same one-write-surface law as every client: everything below is the
 * public /v1 + /api/auth contract.
 *
 * Two editing modes per tab (studio-visual.ts): "raw" (the JSON/CSS
 * textareas) and "visual" (field-row builder / color pickers / block
 * editor) — both edit the same document; Apply PUTs identical bodies.
 */
import { visualJs } from "./studio-visual";

export const studioHtml = `<!doctype html>
<html lang="en" data-bs-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>mizan-gpp studio</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<style>
  :root { --mono: ui-monospace, "IBM Plex Mono", monospace; }
  body { background: #14110f; color: #e8e2d9; }
  .kicker { font-family: var(--mono); font-size: .75rem; letter-spacing: .12em; text-transform: uppercase; color: #ff6a45; }
  .kicker::before { content: "// "; opacity: .6; }
  textarea, code, .mono { font-family: var(--mono); font-size: .8rem; }
  .card { background: #1c1815; border-color: #3a342d; }
  .btn-primary { --bs-btn-bg: #d9482b; --bs-btn-border-color: #d9482b; --bs-btn-hover-bg: #b23415; --bs-btn-hover-border-color: #b23415; }
  .nav-tabs .nav-link.active { background: #1c1815; color: #e8e2d9; border-color: #3a342d #3a342d #1c1815; }
</style>
</head>
<body>
<main class="container py-4" style="max-width:60rem">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div><p class="kicker mb-0">mizan-gpp</p><h1 class="h3 mb-0">Developer studio</h1></div>
    <button id="signout" class="btn btn-sm btn-outline-secondary d-none">Sign out</button>
  </div>

  <div id="gate" class="card mx-auto" style="max-width:24rem"><div class="card-body vstack gap-2">
    <h2 class="h5" id="gate-title">Sign in</h2>
    <input id="g-name" class="form-control d-none" placeholder="Name">
    <input id="g-email" type="email" class="form-control" placeholder="Email">
    <input id="g-pass" type="password" class="form-control" placeholder="Password">
    <p id="g-error" class="text-danger small d-none mb-0"></p>
    <button id="g-go" class="btn btn-primary">Sign in</button>
    <button id="g-mode" class="btn btn-link btn-sm">Create an account instead</button>
  </div></div>

  <div id="studio" class="d-none">
    <div class="d-flex gap-2 align-items-center mb-3">
      <select id="project" class="form-select" style="max-width:22rem"></select>
      <input id="new-name" class="form-control" style="max-width:14rem" placeholder="New project name">
      <button id="new-go" class="btn btn-outline-primary">Create</button>
      <div class="btn-group btn-group-sm ms-auto" role="group" aria-label="Editing mode">
        <button id="mode-raw" type="button" class="btn btn-outline-secondary">Raw</button>
        <button id="mode-visual" type="button" class="btn btn-outline-secondary">Visual</button>
      </div>
    </div>
    <ul class="nav nav-tabs">
      <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#t-col">Collections</button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#t-theme">Themes</button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#t-pages">Pages</button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#t-forms">Forms</button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#t-proj">Project</button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#t-keys">Keys</button></li>
    </ul>
    <div class="tab-content pt-3">
      <div class="tab-pane fade show active" id="t-col">
        <div class="row g-3">
          <div class="col-md-4"><div id="col-list" class="list-group"></div>
            <button id="col-new" class="btn btn-sm btn-outline-primary mt-2">New collection</button></div>
          <div class="col-md-8">
            <input id="col-slug" class="form-control form-control-sm mono mb-2" placeholder="slug">
            <div data-raw><textarea id="col-body" class="form-control" rows="16" spellcheck="false"></textarea></div>
            <div data-visual class="d-none">
              <div class="d-flex gap-2 mb-2">
                <input id="v-singular" class="form-control form-control-sm mono" placeholder="singular">
                <input id="v-plural" class="form-control form-control-sm mono" placeholder="plural">
              </div>
              <div class="d-flex gap-3 flex-wrap mb-2 small align-items-center">
                <label class="d-flex align-items-center gap-1">create <select id="v-pol-create" class="form-select form-select-sm w-auto"><option value="">—</option><option>public</option><option>authenticated</option><option>owner</option></select></label>
                <label class="d-flex align-items-center gap-1">list <select id="v-pol-list" class="form-select form-select-sm w-auto"><option value="">—</option><option>public</option><option>authenticated</option><option>owner</option></select></label>
                <label class="d-flex align-items-center gap-1">get <select id="v-pol-get" class="form-select form-select-sm w-auto"><option value="">—</option><option>public</option><option>authenticated</option><option>owner</option></select></label>
                <label class="d-flex align-items-center gap-1">update <select id="v-pol-update" class="form-select form-select-sm w-auto"><option value="">—</option><option>public</option><option>authenticated</option><option>owner</option></select></label>
                <label class="d-flex align-items-center gap-1">delete <select id="v-pol-delete" class="form-select form-select-sm w-auto"><option value="">—</option><option>public</option><option>authenticated</option><option>owner</option></select></label>
              </div>
              <div id="v-fields" class="vstack"></div>
              <button id="v-add-field" class="btn btn-sm btn-outline-primary mt-2">Add field</button>
              <p class="small text-secondary mt-1 mb-0">An "owner" policy auto-adds the created_by field + owner binding on apply.</p>
            </div>
            <div class="d-flex gap-2 mt-2">
              <button id="col-save" class="btn btn-primary btn-sm">Apply definition</button>
              <button id="col-del" class="btn btn-outline-danger btn-sm">Delete</button>
            </div>
          </div>
        </div>
      </div>
      <div class="tab-pane fade" id="t-theme">
        <div class="d-flex gap-2 mb-2 align-items-center">
          <select id="theme-pick" class="form-select form-select-sm" style="max-width:14rem"></select>
          <input id="theme-slug" class="form-control form-control-sm mono" style="max-width:12rem" placeholder="slug (new)">
          <span class="small text-secondary">served at /v1/projects/{p}/theme.css</span>
        </div>
        <div data-raw><textarea id="theme-body" class="form-control" rows="16" spellcheck="false"></textarea></div>
        <div data-visual class="d-none">
          <div id="v-theme"></div>
          <p class="small text-secondary mt-2 mb-0">Color picks write hex back into the token (any CSS color is legal); other tokens edit as text. Non-token CSS is preserved only in Raw mode.</p>
        </div>
        <button id="theme-save" class="btn btn-primary btn-sm mt-2">Apply theme</button>
      </div>
      <div class="tab-pane fade" id="t-pages">
        <div class="d-flex gap-2 mb-2">
          <select id="page-pick" class="form-select form-select-sm" style="max-width:14rem"></select>
          <input id="page-slug" class="form-control form-control-sm mono" style="max-width:14rem" placeholder="slug (or slug@ar)">
        </div>
        <div data-raw><textarea id="page-body" class="form-control" rows="14" spellcheck="false"></textarea></div>
        <div data-visual class="d-none">
          <input id="v-page-title" class="form-control form-control-sm mb-2" placeholder="Page title">
          <div id="v-blocks"></div>
          <div class="d-flex gap-2">
            <button id="v-add-hero" class="btn btn-sm btn-outline-primary">+ Hero</button>
            <button id="v-add-md" class="btn btn-sm btn-outline-primary">+ Markdown</button>
          </div>
        </div>
        <button id="page-save" class="btn btn-primary btn-sm mt-2">Apply page</button>
      </div>
      <div class="tab-pane fade" id="t-forms">
        <div id="form-list" class="vstack gap-2 mb-3"></div>
        <div class="d-flex gap-2">
          <input id="form-name" class="form-control form-control-sm" style="max-width:14rem" placeholder="Display name">
          <input id="form-email" class="form-control form-control-sm" style="max-width:16rem" placeholder="notify email">
          <button id="form-new" class="btn btn-primary btn-sm">Create form</button>
        </div>
      </div>
      <div class="tab-pane fade" id="t-proj">
        <p class="small text-secondary mb-1">The project document (auth_pool, site.locales, …) — merge-PATCHed.</p>
        <textarea id="proj-body" class="form-control" rows="12" spellcheck="false"></textarea>
        <button id="proj-save" class="btn btn-primary btn-sm mt-2">PATCH project</button>
      </div>
      <div class="tab-pane fade" id="t-keys">
        <p class="small text-secondary">Mint an sk_ secret key (sync, seed, MCP, the app admin). Shown once.</p>
        <button id="key-mint" class="btn btn-primary btn-sm">Mint sk_ key</button>
        <code id="key-out" class="d-block mt-2 p-2 rounded d-none" style="background:#241f1a"></code>
        <p class="small text-secondary mt-3 mb-0">Contract: <a id="lnk-oas" href="#">openapi.json</a> · MCP: <code id="lnk-mcp" class="mono"></code></p>
      </div>
    </div>
  </div>
</main>
<script>
const el = (id) => document.getElementById(id);
const j = { "Content-Type": "application/json" };
const api = (path, init = {}) => fetch(path, { ...init, headers: { ...j, ...(init.headers ?? {}) } });
const toast = (message, ok = true) => {
  const node = document.createElement("div");
  node.className = "alert alert-" + (ok ? "success" : "danger") + " position-fixed bottom-0 end-0 m-3";
  node.textContent = message; document.body.appendChild(node); setTimeout(() => node.remove(), 4000);
};
let mode = "in", pid = null;

async function session() { return (await (await fetch("/api/auth/get-session")).json())?.user ?? null; }
el("g-mode").onclick = () => {
  mode = mode === "in" ? "up" : "in";
  el("gate-title").textContent = mode === "in" ? "Sign in" : "Create an account";
  el("g-go").textContent = mode === "in" ? "Sign in" : "Create account";
  el("g-mode").textContent = mode === "in" ? "Create an account instead" : "Sign in instead";
  el("g-name").classList.toggle("d-none", mode === "in");
};
el("g-go").onclick = async () => {
  const body = { email: el("g-email").value, password: el("g-pass").value, ...(mode === "up" ? { name: el("g-name").value || el("g-email").value } : {}) };
  const response = await api("/api/auth/sign-" + (mode === "in" ? "in" : "up") + "/email", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) { el("g-error").textContent = "Refused — check the credentials."; return el("g-error").classList.remove("d-none"); }
  boot();
};
el("signout").onclick = async () => { await api("/api/auth/sign-out", { method: "POST", body: "{}" }); location.reload(); };

async function boot() {
  if (!(await session())) return;
  el("gate").classList.add("d-none"); el("studio").classList.remove("d-none"); el("signout").classList.remove("d-none");
  const { results } = await (await api("/v1/projects")).json();
  el("project").innerHTML = results.map((p) => '<option value="' + p.path.split("/")[1] + '">' + p.display_name + " (" + p.path.split("/")[1].slice(0, 8) + "…)</option>").join("");
  if (results.length) { pid = el("project").value; loadProject(); }
}
el("project").onchange = () => { pid = el("project").value; loadProject(); };
el("new-go").onclick = async () => {
  const response = await api("/v1/projects", { method: "POST", body: JSON.stringify({ display_name: el("new-name").value || "Untitled" }) });
  toast(response.ok ? "Project created" : "Failed", response.ok); boot();
};

async function loadProject() {
  const [cols, themes, pages, forms, proj] = await Promise.all([
    api("/v1/projects/" + pid + "/collections").then((r) => r.json()).catch(() => ({ results: [] })),
    api("/v1/projects/" + pid + "/themes").then((r) => r.json()).catch(() => ({ results: [] })),
    api("/v1/projects/" + pid + "/pages").then((r) => r.json()).catch(() => ({ results: [] })),
    api("/v1/projects/" + pid + "/forms").then((r) => r.json()).catch(() => ({ results: [] })),
    api("/v1/projects/" + pid).then((r) => r.json()),
  ]);
  el("col-list").innerHTML = (cols.results ?? []).map((c) => {
    const slug = c.path.split("/").pop();
    return '<button class="list-group-item list-group-item-action mono" data-col="' + slug + '">' + slug + "</button>";
  }).join("") || '<p class="small text-secondary">none yet</p>';
  el("theme-pick").innerHTML = '<option value="">(new)</option>' + (themes.results ?? []).map((t) => { const s = t.path.split("/").pop(); return '<option>' + s + "</option>"; }).join("");
  el("page-pick").innerHTML = '<option value="">(new)</option>' + (pages.results ?? []).map((t) => { const s = t.path.split("/").pop(); return '<option>' + s + "</option>"; }).join("");
  el("form-list").innerHTML = (forms.results ?? []).map((f) =>
    '<div class="card"><div class="card-body py-2 small d-flex justify-content-between"><span>' + f.display_name + " → " + f.notify_email +
    '</span><code class="mono">' + (f.submit_key ?? "") + "</code></div></div>").join("") || '<p class="small text-secondary">none yet</p>';
  const { path, create_time, update_time, ...editable } = proj;
  el("proj-body").value = JSON.stringify(editable, null, 2);
  el("lnk-oas").href = "/v1/projects/" + pid + "/openapi.json";
  el("lnk-mcp").textContent = location.origin + "/v1/projects/" + pid + "/mcp";
}

el("col-list").addEventListener("click", async (event) => {
  const slug = event.target.dataset?.col;
  if (!slug) return;
  const row = await (await api("/v1/projects/" + pid + "/collections/" + slug)).json();
  el("col-slug").value = slug;
  el("col-body").value = JSON.stringify({ definition: row.definition }, null, 2);
  window.refreshVisual?.();
});
el("col-new").onclick = () => {
  el("col-slug").value = "";
  el("col-body").value = JSON.stringify({ definition: { singular: "thing", plural: "things", fields: [{ name: "title", type: "string", required: true }], policy_create: "authenticated", policy_list: "public", policy_get: "public" } }, null, 2);
  window.refreshVisual?.();
};
el("col-save").onclick = async () => {
  try {
    const response = await api("/v1/projects/" + pid + "/collections/" + el("col-slug").value, { method: "PUT", body: JSON.stringify(JSON.parse(el("col-body").value)) });
    toast(response.ok ? "Definition applied — live immediately" : (await response.json()).detail ?? "Refused", response.ok);
    loadProject();
  } catch { toast("Invalid JSON", false); }
};
el("col-del").onclick = async () => {
  const response = await api("/v1/projects/" + pid + "/collections/" + el("col-slug").value, { method: "DELETE" });
  toast(response.ok ? "Deleted" : "Refused", response.ok); loadProject();
};

el("theme-pick").onchange = async () => {
  const slug = el("theme-pick").value;
  el("theme-slug").value = slug;
  el("theme-body").value = slug ? (await (await api("/v1/projects/" + pid + "/themes/" + slug)).json()).css ?? "" : "";
  window.refreshVisual?.();
};
el("theme-save").onclick = async () => {
  const slug = el("theme-slug").value || "default";
  const response = await api("/v1/projects/" + pid + "/themes/" + slug, { method: "PUT", body: JSON.stringify({ css: el("theme-body").value }) });
  toast(response.ok ? "Theme applied" : "Refused", response.ok); loadProject();
};
el("page-pick").onchange = async () => {
  const slug = el("page-pick").value;
  el("page-slug").value = slug;
  if (!slug) el("page-body").value = JSON.stringify({ title: "New page", data: { root: { props: {} }, content: [] } }, null, 2);
  else {
    const row = await (await api("/v1/projects/" + pid + "/pages/" + slug)).json();
    const { path, create_time, update_time, created_by, ...doc } = row;
    el("page-body").value = JSON.stringify(doc, null, 2);
  }
  window.refreshVisual?.();
};
el("page-save").onclick = async () => {
  try {
    const response = await api("/v1/projects/" + pid + "/pages/" + el("page-slug").value, { method: "PUT", body: el("page-body").value });
    toast(response.ok ? "Page applied" : "Refused", response.ok); loadProject();
  } catch { toast("Invalid JSON", false); }
};
el("form-new").onclick = async () => {
  const response = await api("/v1/projects/" + pid + "/forms", { method: "POST", body: JSON.stringify({ display_name: el("form-name").value || "Form", notify_email: el("form-email").value }) });
  toast(response.ok ? "Form created (pk key below)" : "Refused", response.ok); loadProject();
};
el("proj-save").onclick = async () => {
  try {
    const response = await api("/v1/projects/" + pid, { method: "PATCH", body: el("proj-body").value });
    toast(response.ok ? "Project patched" : "Refused", response.ok);
  } catch { toast("Invalid JSON", false); }
};
el("key-mint").onclick = async () => {
  const response = await api("/v1/keys:mint", { method: "POST", body: "{}" });
  if (!response.ok) return toast("Refused", false);
  el("key-out").textContent = (await response.json()).plaintext;
  el("key-out").classList.remove("d-none");
};
boot();
${visualJs}
</script>
</body>
</html>`;
