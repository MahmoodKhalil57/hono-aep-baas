import { bootstrapUiSource } from "./generated/bootstrap-ui-source";

/**
 * Hosted site assets (baas/site.md §2): the baas serves each project's
 * admin.html, bootstrap-ui.js, manifest.webmanifest, robots.txt,
 * sitemap.xml, llms.txt and sw.js at /v1/projects/{p}/site/{asset},
 * generated from the project document (site.*, pushed by sync from the
 * config repo) + PUBLIC collection reads (policies gate what leaks).
 * Frontends may still self-host: for origin-bound assets (robots.txt,
 * sw.js — a service worker only controls its own origin) the hosted
 * copy is the canonical generated artifact to copy at publish time;
 * manifest/admin work cross-origin directly.
 */

type Json = Record<string, unknown>;
export type SiteDoc = {
  url?: string;
  description?: string;
  locales?: { default?: string };
  app?: {
    name?: string;
    shortName?: string;
    themeColor?: string;
    backgroundColor?: string;
    cacheName?: string;
    icons?: Json[];
  };
  assets?: {
    robots?: { extra?: string[] };
    sitemap?: { urls?: string[]; collections?: { slug: string; url: string }[] };
    llms?: {
      intro?: string;
      sections?: { title: string; collection: string; url: string; label?: string; note?: string }[];
      links?: { title: string; url: string; note?: string }[];
    };
  };
};
export type FetchPublic = (plural: string) => Promise<Json[]>;

const xml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const idOf = (row: Json) => String(row.path ?? "").split("/").pop() ?? "";
const flat = (value: unknown): string =>
  typeof value === "object" && value !== null ? String(Object.values(value as Json)[0] ?? "") : String(value ?? "");

export function manifestJson(displayName: string, site: SiteDoc): Json {
  const app = site.app ?? {};
  return {
    name: app.name ?? displayName,
    short_name: app.shortName ?? displayName,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: app.backgroundColor ?? "#faf6f0",
    theme_color: app.themeColor ?? "#d9482b",
    icons: app.icons ?? [],
  };
}

export function robotsTxt(site: SiteDoc, hostedBase: string): string {
  const lines = ["User-agent: *", "Allow: /", ...(site.assets?.robots?.extra ?? [])];
  const sitemapAt = site.url ? `${site.url.replace(/\/$/, "")}/sitemap.xml` : `${hostedBase}/sitemap.xml`;
  return `${lines.join("\n")}\n\nSitemap: ${sitemapAt}\n`;
}

export function swJs(site: SiteDoc): string {
  const cache = site.app?.cacheName ?? "site-v1";
  return `/* Generated MPA service worker (baas/site.md §2): network-first,
   cache fallback — no precache list to maintain. ORIGIN-BOUND: a service
   worker only controls the origin it is served from; cross-origin
   frontends copy this file at publish time. */
const CACHE = ${JSON.stringify(cache)};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (response.ok && new URL(event.request.url).origin === location.origin) {
          (await caches.open(CACHE)).put(event.request, response.clone());
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) ?? Response.error()),
  );
});
`;
}

export async function sitemapXml(site: SiteDoc, fetchPublic: FetchPublic): Promise<string | null> {
  const baseUrl = site.url?.replace(/\/$/, "");
  if (!baseUrl) return null; // absolute URLs are the point of a sitemap
  const entries: { loc: string; lastmod?: string }[] = (site.assets?.sitemap?.urls ?? ["/"]).map((path) => ({
    loc: `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`,
  }));
  for (const source of site.assets?.sitemap?.collections ?? []) {
    for (const row of await fetchPublic(source.slug)) {
      entries.push({
        loc: `${baseUrl}${source.url.replace("{id}", encodeURIComponent(idOf(row)))}`,
        lastmod: typeof row.update_time === "string" ? row.update_time.split("T")[0] : undefined,
      });
    }
  }
  const body = entries
    .map((e) => `  <url><loc>${xml(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export async function llmsTxt(displayName: string, site: SiteDoc, fetchPublic: FetchPublic): Promise<string> {
  const baseUrl = site.url?.replace(/\/$/, "") ?? "";
  const parts = [`# ${displayName}`, "", `> ${site.description ?? ""}`, ""];
  if (site.assets?.llms?.intro) parts.push(site.assets.llms.intro, "");
  for (const section of site.assets?.llms?.sections ?? []) {
    parts.push(`## ${section.title}`);
    for (const row of await fetchPublic(section.collection)) {
      const label = flat(row[section.label ?? "name"] ?? row.title) || idOf(row);
      const note = section.note ? flat(row[section.note]) : "";
      parts.push(`- [${label}](${baseUrl}${section.url.replace("{id}", encodeURIComponent(idOf(row)))})${note ? `: ${note}` : ""}`);
    }
    parts.push("");
  }
  if (site.assets?.llms?.links?.length) {
    parts.push("## Links");
    for (const link of site.assets.llms.links) parts.push(`- [${link.title}](${link.url})${link.note ? `: ${link.note}` : ""}`);
    parts.push("");
  }
  return parts.join("\n");
}

export const bootstrapUiJs = (): string => bootstrapUiSource;

/**
 * The hosted DEFAULT admin (application plane, same-origin with the API):
 * the sibling of the vendored pure-frontend admin — collection tabs from
 * site.admin + the project's own openapi.json via the bootstrap-ui module
 * served next door. sk_ key gate; one-write-surface throughout.
 */
export function adminHtml(): string {
  return `<!doctype html>
<html lang="en" data-bs-theme="light">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Admin</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="../theme.css">
<script defer src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</head>
<body class="bg-body">
<main class="container py-4" style="max-width:64rem">
  <div id="gate" class="card mx-auto" style="max-width:26rem"><div class="card-body vstack gap-3">
    <h1 class="h4 mb-0">Store admin</h1>
    <p class="text-body-secondary small mb-0">Unlock with your sk_ key. Stored in this browser only; every action is the public API under the key's policies.</p>
    <input id="key-input" type="password" class="form-control" placeholder="sk_live_…">
    <p id="gate-error" class="text-danger small d-none mb-0"></p>
    <button id="unlock" class="btn btn-primary">Unlock</button>
  </div></div>
  <div id="panel" class="d-none">
    <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
      <h1 class="h3 mb-0" id="title">Admin</h1>
      <span class="d-flex gap-2"><select id="admin-locale" class="form-select form-select-sm w-auto"></select>
      <button id="lock" class="btn btn-sm btn-outline-secondary">Lock</button></span>
    </div>
    <ul class="nav nav-tabs" id="admin-tabs"></ul>
    <div class="tab-content pt-3" id="admin-panes"></div>
  </div>
</main>
<script type="module">
import { loadAdminModel, tableHtml, formHtml, readForm } from "./bootstrap-ui.js";
const base = location.pathname.replace(/\\/site\\/admin\\.html$/, "");
const el = (id) => document.getElementById(id);
const KEY = "baas.admin-key." + base.split("/").pop();
const auth = () => ({ Authorization: "Bearer " + localStorage.getItem(KEY) });
const api = (path, init = {}) => fetch(base + path, { ...init, headers: { "Content-Type": "application/json", ...auth(), ...(init.headers ?? {}) } });
const locale = () => el("admin-locale").value || "en";
const toast = (message, ok = true) => {
  const node = document.createElement("div");
  node.className = "alert alert-" + (ok ? "success" : "danger") + " position-fixed bottom-0 end-0 m-3";
  node.textContent = message; document.body.appendChild(node); setTimeout(() => node.remove(), 4000);
};

el("unlock").onclick = async () => {
  const key = el("key-input").value.trim();
  const probe = await fetch(base, { headers: { Authorization: "Bearer " + key } });
  if (!probe.ok) { el("gate-error").textContent = "That key was refused (owner keys only)."; return el("gate-error").classList.remove("d-none"); }
  localStorage.setItem(KEY, key); void unlock(await probe.json());
};
el("lock").onclick = () => { localStorage.removeItem(KEY); location.reload(); };

async function unlock(project) {
  project ??= await api("").then((r) => (r.ok ? r.json() : null));
  if (!project) return;
  el("gate").classList.add("d-none"); el("panel").classList.remove("d-none");
  el("title").textContent = project.display_name ?? "Admin";
  const admin = project.site?.admin ?? { collections: [] };
  const locales = project.site?.locales?.supported ?? ["en"];
  el("admin-locale").innerHTML = locales.map((code) => "<option>" + code + "</option>").join("");
  if (admin.commerce) mountOrders();
  const model = await loadAdminModel(base + "/openapi.json");
  for (const entry of admin.collections ?? []) mountCollection(model, entry);
  const first = document.querySelector("#admin-tabs .nav-link");
  if (first) new bootstrap.Tab(first).show();
}
el("admin-locale").onchange = () => document.querySelectorAll("[data-collection]").forEach((pane) => pane.refresh?.());
if (localStorage.getItem(KEY)) void unlock();

// Commerce is its own surface (not in the collections contract) — one
// bespoke pane: stats cards + orders with contract-legal transitions.
const NEXT = { paid: ["fulfilled", "cancelled"], fulfilled: ["shipped"], shipped: ["delivered"], pending: ["cancelled"] };
const money = (cents) => "$" + ((cents ?? 0) / 100).toFixed(2);
function mountOrders() {
  el("admin-tabs").insertAdjacentHTML("beforeend",
    '<li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-orders">Orders</button></li>');
  el("admin-panes").insertAdjacentHTML("beforeend",
    '<div class="tab-pane fade" id="tab-orders"><div id="stat-cards" class="row g-3 mb-3"></div><div id="orders-list" class="vstack gap-2"></div></div>');
  const refresh = async () => {
    const stats = await api("/commerce/stats").then((r) => r.json()).catch(() => ({}));
    el("stat-cards").innerHTML = [["Orders", stats.orders ?? 0], ["Revenue", money(stats.revenue_cents)],
      ...Object.entries(stats.by_status ?? {})].map(([label, value]) =>
      '<div class="col-6 col-md-3"><div class="card"><div class="card-body py-2"><p class="small text-body-secondary mb-1">' + label + '</p><div class="fs-4">' + value + "</div></div></div></div>").join("");
    const { orders } = await api("/commerce/orders?all=1").then((r) => r.json()).catch(() => ({ orders: [] }));
    el("orders-list").innerHTML = (orders ?? []).map((order) =>
      '<div class="card"><div class="card-body py-2 d-flex justify-content-between align-items-center flex-wrap gap-1">' +
      '<span class="small">' + (order.items ?? []).map((i) => i.quantity + "× " + (i.name ?? i.product_id)).join(", ") + "</span>" +
      '<span class="d-flex gap-2 align-items-center"><span class="small">' + money(order.total_cents) + "</span>" +
      '<span class="badge text-bg-secondary">' + order.status + "</span>" +
      (NEXT[order.status] ?? []).map((to) => '<button class="btn btn-sm btn-outline-primary py-0" data-advance="' + order.id + '" data-to="' + to + '">' + to + "</button>").join("") +
      "</span></div></div>").join("") || '<p class="text-body-secondary small">No orders yet.</p>';
  };
  el("orders-list").parentElement.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-advance]");
    if (!button) return;
    const response = await api("/commerce/orders/" + button.dataset.advance + ":advance", { method: "POST", body: JSON.stringify({ to: button.dataset.to }) });
    toast(response.ok ? "Order → " + button.dataset.to + " ✓" : "Refused", response.ok);
    void refresh();
  });
  void refresh();
}

function mountCollection(model, entry) {
  const conf = typeof entry === "string" ? { slug: entry } : entry;
  const resource = model.byPlural(conf.slug);
  if (!resource) return;
  const media = conf.media ?? [];
  const paneId = "tab-c-" + conf.slug;
  el("admin-tabs").insertAdjacentHTML("beforeend",
    '<li class="nav-item"><button class="nav-link text-capitalize" data-bs-toggle="tab" data-bs-target="#' + paneId + '">' + conf.slug + "</button></li>");
  el("admin-panes").insertAdjacentHTML("beforeend",
    '<div class="tab-pane fade" id="' + paneId + '" data-collection="' + conf.slug + '">' +
    '<div data-list class="mb-4"></div>' +
    '<div class="card"><div class="card-body vstack gap-2">' +
    '<div class="d-flex justify-content-between"><h6 data-form-title class="mb-0">New ' + resource.name + "</h6>" +
    '<button data-new class="btn btn-sm btn-link p-0 d-none">+ new instead</button></div>' +
    '<input data-id-input class="form-control form-control-sm font-monospace" placeholder="id (e.g. slug)" style="max-inline-size:16rem">' +
    "<div data-form></div>" +
    '<button data-save class="btn btn-primary btn-sm align-self-start">Save ' + resource.name + "</button>" +
    "</div></div></div>");
  const pane = el(paneId);
  const idInput = pane.querySelector("[data-id-input]");
  let editing = "";
  const renderForm = (row = {}) => {
    pane.querySelector("[data-form]").innerHTML = formHtml(resource, row, { mediaFields: media, locale: locale() });
    pane.querySelector("[data-form-title]").textContent = editing ? "Edit: " + editing : "New " + resource.name;
    pane.querySelector("[data-new]").classList.toggle("d-none", !editing);
    idInput.value = editing; idInput.disabled = !!editing;
  };
  pane.refresh = async () => {
    const { results } = await api("/" + conf.slug + "?locale=all").then((r) => r.json()).catch(() => ({ results: [] }));
    pane.querySelector("[data-list]").innerHTML = tableHtml(resource, results ?? [], { locale: locale() });
    if (!editing) renderForm();
  };
  pane.addEventListener("click", async (event) => {
    const edit = event.target.closest?.("[data-edit]"), del = event.target.closest?.("[data-del]");
    if (edit) { editing = edit.dataset.edit; renderForm(await (await api("/" + conf.slug + "/" + editing + "?locale=" + locale())).json()); }
    else if (del) {
      if (!confirm("Delete " + conf.slug + "/" + del.dataset.del + "?")) return;
      const response = await api("/" + conf.slug + "/" + del.dataset.del, { method: "DELETE" });
      toast(response.ok ? "Deleted ✓" : "Refused (" + response.status + ")", response.ok);
      void pane.refresh();
    }
  });
  pane.querySelector("[data-new]").onclick = () => { editing = ""; renderForm(); };
  pane.addEventListener("change", async (event) => {
    const field = event.target.dataset?.media;
    if (!field) return;
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData(); form.append("file", file);
    const response = await fetch(base + "/media:upload", { method: "POST", headers: auth(), body: form });
    if (!response.ok) return toast("Upload failed", false);
    pane.querySelector("#af-" + field).value = (await response.json()).results[0].path.split("/")[1];
    pane.querySelector('[data-media-state="' + field + '"]').textContent = "uploaded ✓ (" + file.name + ")";
  });
  pane.querySelector("[data-save]").onclick = async () => {
    let wire;
    try { wire = readForm(resource, pane, { mediaFields: media }); } catch (thrown) { return toast(thrown.message, false); }
    const id = editing || idInput.value.trim() || (conf.idField ? String(wire[conf.idField] ?? "") : "");
    if (!id) return toast("An id is required (fill the id box).", false);
    const response = editing
      ? await api("/" + conf.slug + "/" + id + "?locale=" + locale(), { method: "PATCH", body: JSON.stringify(wire) })
      : await api("/" + conf.slug + "?id=" + encodeURIComponent(id) + "&locale=" + locale(), { method: "POST", body: JSON.stringify(wire) });
    toast(response.ok ? resource.name + " saved ✓" : "Save failed (" + response.status + ")", response.ok);
    if (response.ok) { editing = ""; void pane.refresh(); }
  };
  void pane.refresh();
}
</script>
</body>
</html>`;
}
