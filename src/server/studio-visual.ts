/**
 * The VISUAL BUILDER layer of the hosted studio (the /developer-style
 * mode): field-row collection builder, theme token rows with color
 * pickers (oklch→hex for display; picks write back as hex — any CSS
 * color is a legal token value), and a page block editor. Both modes
 * edit the SAME document — the toggle just re-renders it. Kept as a
 * plain-JS string (no backticks: it is embedded in a template literal).
 */
export const visualJs = `
// ---------- mode toggle ----------
const modeKey = "studio-mode";
const getMode = () => localStorage.getItem(modeKey) === "visual" ? "visual" : "raw";
function applyMode() {
  const visual = getMode() === "visual";
  document.querySelectorAll("[data-raw]").forEach((n) => n.classList.toggle("d-none", visual));
  document.querySelectorAll("[data-visual]").forEach((n) => n.classList.toggle("d-none", !visual));
  el("mode-visual").classList.toggle("active", visual);
  el("mode-raw").classList.toggle("active", !visual);
  if (visual) { defToVisual(); themeToVisual(); pageToVisual(); }
}
el("mode-visual").onclick = () => { syncFromActive(); localStorage.setItem(modeKey, "visual"); applyMode(); };
el("mode-raw").onclick = () => { syncFromActive(); localStorage.setItem(modeKey, "raw"); applyMode(); };
function syncFromActive() {
  if (getMode() !== "visual") return;
  visualToDef(); visualToTheme(); visualToPage();
}
// Raw handlers repopulate the textareas; this re-renders the builders.
window.refreshVisual = () => { if (getMode() === "visual") { defToVisual(); themeToVisual(); pageToVisual(); } };
// One Apply button per tab, mode-aware: in visual mode it serializes the
// builder into the raw document first, then the raw handler PUTs it.
for (const pair of [["col-save", () => visualToDef()], ["theme-save", () => visualToTheme()], ["page-save", () => visualToPage()]]) {
  const button = el(pair[0]), raw = button.onclick;
  button.onclick = () => { if (getMode() === "visual") pair[1](); return raw(); };
}

// ---------- collections: field-row builder ----------
const TYPES = ["string", "integer", "number", "boolean", "date", "datetime", "object", "any"];
const POLICIES = ["", "public", "authenticated", "owner"];
function defToVisual() {
  let doc; try { doc = JSON.parse(el("col-body").value).definition ?? {}; } catch { return; }
  el("v-singular").value = doc.singular ?? "";
  el("v-plural").value = doc.plural ?? "";
  ["create", "list", "get", "update", "delete"].forEach((verb) => {
    const policy = doc["policy_" + verb];
    el("v-pol-" + verb).value = typeof policy === "object" ? "owner" : (policy ?? "");
  });
  el("v-fields").innerHTML = "";
  (doc.fields ?? []).forEach(addFieldRow);
  if (!(doc.fields ?? []).length) addFieldRow({});
}
function addFieldRow(field) {
  const type = field.integer ? "integer" : (field.type ?? "string");
  const row = document.createElement("div");
  row.className = "d-flex gap-2 align-items-center flex-wrap border-bottom pb-2 pt-1 v-field";
  row.innerHTML =
    '<input class="form-control form-control-sm mono f-name" style="max-inline-size:11rem" placeholder="field name" value="' + (field.name ?? "") + '">' +
    '<select class="form-select form-select-sm f-type" style="max-inline-size:8rem">' +
      TYPES.map((t) => '<option' + (t === type ? " selected" : "") + '>' + t + "</option>").join("") + "</select>" +
    ["required", "unique", "indexed", "localized"].map((flag) =>
      '<label class="form-check-label small d-flex align-items-center gap-1">' +
      '<input type="checkbox" class="form-check-input f-' + flag + '"' + (field[flag] ? " checked" : "") + ">" + flag + "</label>").join("") +
    '<input class="form-control form-control-sm mono f-enum" style="max-inline-size:12rem" placeholder="enum: a,b,c" value="' + (field.enum_values ?? []).join(",") + '">' +
    '<button class="btn btn-sm btn-link text-danger p-0 f-del">remove</button>';
  row.querySelector(".f-del").onclick = () => row.remove();
  el("v-fields").appendChild(row);
}
el("v-add-field").onclick = () => addFieldRow({});
function visualToDef() {
  const fields = [...document.querySelectorAll(".v-field")].map((row) => {
    const name = row.querySelector(".f-name").value.trim();
    if (!name) return null;
    const type = row.querySelector(".f-type").value;
    const flag = (cls) => row.querySelector(".f-" + cls).checked;
    const enums = row.querySelector(".f-enum").value.split(",").map((s) => s.trim()).filter(Boolean);
    return {
      name,
      type: type === "integer" ? "number" : type,
      ...(type === "integer" ? { integer: true } : {}),
      ...(flag("required") ? { required: true } : {}),
      ...(flag("unique") ? { unique: true } : {}),
      ...(flag("indexed") ? { indexed: true } : {}),
      ...(flag("localized") ? { localized: true } : {}),
      ...(enums.length ? { enum_values: enums } : {}),
    };
  }).filter(Boolean);
  // Never clobber the raw document from a builder that was never rendered
  // (e.g. the textarea held invalid JSON when the mode flipped).
  if (!el("v-singular").value.trim() && !el("v-plural").value.trim() && !fields.length) return;
  const doc = { singular: el("v-singular").value.trim(), plural: el("v-plural").value.trim(), fields };
  let usesOwner = false;
  ["create", "list", "get", "update", "delete"].forEach((verb) => {
    const value = el("v-pol-" + verb).value;
    if (!value) return;
    if (value === "owner") { usesOwner = true; doc["policy_" + verb] = { owner: { field: "created_by" } }; }
    else doc["policy_" + verb] = value;
  });
  // The classic footgun, guarded in the builder itself: an owner policy
  // needs the owner binding AND the field — auto-added here.
  if (usesOwner) {
    doc.owner = "created_by";
    if (!fields.some((f) => f.name === "created_by")) fields.push({ name: "created_by", type: "string" });
  }
  el("col-body").value = JSON.stringify({ definition: doc }, null, 2);
}

// ---------- theme: token rows with color pickers ----------
function oklchToHex(value) {
  const m = value.match(/oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
  if (!m) return null;
  const [L, C, H] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hr = H * Math.PI / 180, a = C * Math.cos(hr), bb = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
  const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
  const lin = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
  ];
  const srgb = lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
  return "#" + srgb.map((n) => n.toString(16).padStart(2, "0")).join("");
}
const isColorValue = (v) => /^(oklch|#|rgb|hsl)/.test(v.trim());
// <input type=color> only accepts #rrggbb — expand #abc, truncate #rrggbbaa.
const normHex = (h) => (h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h.slice(0, 7));
function parseThemeTokens(css) {
  const scopes = {};
  for (const m of css.matchAll(/(^|\\n)\\s*(:root|\\.dark)[^{]*\\{([^}]*)\\}/g)) {
    const scope = m[2] === ".dark" ? ".dark" : ":root";
    scopes[scope] ??= [];
    for (const t of m[3].matchAll(/--([a-z0-9-]+)\\s*:\\s*([^;]+);/gi)) scopes[scope].push([t[1], t[2].trim()]);
  }
  return scopes;
}
function themeToVisual() {
  const scopes = parseThemeTokens(el("theme-body").value);
  el("v-theme").innerHTML = Object.entries(scopes).map(([scope, tokens]) =>
    '<p class="kicker mt-3 mb-1">' + (scope === ".dark" ? "dark" : "light") + "</p>" +
    tokens.map(([name, value], at) => {
      const hex = isColorValue(value) ? (value.startsWith("#") ? normHex(value) : oklchToHex(value)) : null;
      return '<div class="d-flex gap-2 align-items-center py-1 v-token" data-scope="' + scope + '" data-name="' + name + '">' +
        '<code class="mono" style="min-inline-size:14rem">--' + name + "</code>" +
        (hex
          ? '<input type="color" class="form-control form-control-color form-control-sm t-color" value="' + hex + '">' +
            '<span class="small text-secondary t-orig">' + value + "</span>"
          : '<input class="form-control form-control-sm mono t-text" value="' + value.replace(/"/g, "&quot;") + '">') +
        "</div>";
    }).join("")).join("");
  document.querySelectorAll(".t-color").forEach((input) => {
    input.oninput = () => { input.parentElement.querySelector(".t-orig").textContent = input.value; };
  });
}
function visualToTheme() {
  const scopes = {};
  document.querySelectorAll(".v-token").forEach((row) => {
    const scope = row.dataset.scope, name = row.dataset.name;
    const color = row.querySelector(".t-color"), text = row.querySelector(".t-text");
    const orig = row.querySelector(".t-orig");
    const value = color ? (orig.textContent.trim()) : text.value.trim();
    (scopes[scope] ??= []).push("  --" + name + ": " + value + ";");
  });
  if (!Object.keys(scopes).length) return;
  const head = (el("theme-body").value.match(/^(\\/\\*[^]*?\\*\\/\\s*)/) ?? ["", ""])[1];
  el("theme-body").value = head +
    ":root {\\n" + (scopes[":root"] ?? []).join("\\n") + "\\n}\\n\\n" +
    (scopes[".dark"] ? ".dark {\\n" + scopes[".dark"].join("\\n") + "\\n}\\n" : "");
}

// ---------- pages: block editor ----------
function pageToVisual() {
  let doc; try { doc = JSON.parse(el("page-body").value); } catch { return; }
  el("v-page-title").value = doc.title ?? "";
  el("v-blocks").innerHTML = "";
  (doc.data?.content ?? []).forEach(addBlockRow);
}
function addBlockRow(block) {
  const row = document.createElement("div");
  row.className = "card mb-2 v-block";
  const type = block.type ?? "Markdown";
  const props = block.props ?? {};
  row.dataset.extra = JSON.stringify(props);
  const known = type === "Hero" || type === "Markdown";
  row.innerHTML = '<div class="card-body py-2 vstack gap-1">' +
    '<div class="d-flex justify-content-between"><strong class="small">' + type + "</strong>" +
    '<span><button class="btn btn-sm btn-link p-0 me-2 b-up">↑</button><button class="btn btn-sm btn-link p-0 me-2 b-down">↓</button><button class="btn btn-sm btn-link text-danger p-0 b-del">remove</button></span></div>' +
    (type === "Hero"
      ? '<input class="form-control form-control-sm b-heading" placeholder="Heading" value="' + (props.heading ?? "").replace(/"/g, "&quot;") + '">' +
        '<input class="form-control form-control-sm b-text" placeholder="Text" value="' + (props.text ?? "").replace(/"/g, "&quot;") + '">'
      : known
        ? '<textarea class="form-control form-control-sm mono b-content" rows="4">' + (props.content ?? "") + "</textarea>"
        : '<p class="small text-secondary mb-0">[' + type + " block — edited in Raw mode]</p>") +
    "</div>";
  row.dataset.type = type;
  row.querySelector(".b-del").onclick = () => row.remove();
  row.querySelector(".b-up").onclick = () => row.previousElementSibling?.before(row);
  row.querySelector(".b-down").onclick = () => row.nextElementSibling?.after(row);
  el("v-blocks").appendChild(row);
}
el("v-add-hero").onclick = () => addBlockRow({ type: "Hero", props: {} });
el("v-add-md").onclick = () => addBlockRow({ type: "Markdown", props: {} });
function visualToPage() {
  const title = el("v-page-title").value;
  if (!title && !document.querySelectorAll(".v-block").length) return;
  const content = [...document.querySelectorAll(".v-block")].map((row, at) => {
    const type = row.dataset.type;
    const extra = JSON.parse(row.dataset.extra || "{}");
    const id = extra.id ?? type + "-" + (at + 1);
    if (type === "Hero") return { type, props: { ...extra, id, heading: row.querySelector(".b-heading").value, text: row.querySelector(".b-text").value } };
    if (type === "Markdown") return { type, props: { ...extra, id, content: row.querySelector(".b-content").value } };
    return { type, props: extra };
  });
  el("page-body").value = JSON.stringify({ title, data: { root: { props: {} }, content } }, null, 2);
}
applyMode();
`;
