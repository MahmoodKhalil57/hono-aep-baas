import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { SiteDoc } from "./site-assets";

/**
 * Edge-rasterized brand assets (baas/site.md §2): OG cards as real PNGs
 * (crawlers reject SVG) via resvg-wasm, brand-styled from site.app.
 * The wasm module is injected per runtime (worker.ts imports the .wasm
 * as a CompiledWasm module; index.ts reads it from node_modules); the
 * display font is fetched from Google Fonts once per isolate — a failed
 * fetch degrades to fontless rendering rather than a 500.
 */

let ready: Promise<void> | undefined;
export function initResvg(wasm: Parameters<typeof initWasm>[0]): void {
  ready ??= initWasm(wasm).catch((error: unknown) => {
    // "already initialized" from a racing isolate warm-up is benign.
    if (!String(error).includes("initialized")) throw error;
  });
}

const FONT_CSS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@600";
let fontPromise: Promise<Uint8Array | null> | undefined;
const loadFont = (): Promise<Uint8Array | null> =>
  (fontPromise ??= (async () => {
    try {
      const css = await (await fetch(FONT_CSS, { headers: { "User-Agent": "curl/8" } })).text();
      const url = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
      return url ? new Uint8Array(await (await fetch(url)).arrayBuffer()) : null;
    } catch {
      return null;
    }
  })());

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Naive word-wrap into at most `max` lines of ~`chars` characters. */
function wrap(text: string, chars: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > chars && line) {
      lines.push(line);
      if (lines.length === max) return [...lines.slice(0, -1), `${lines[max - 1]}…`];
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, max);
}

export type OgCard = { kicker: string; title: string; subtitle?: string; badge?: string };

/** The 1200×630 card: dark editorial — kicker, display title, muted subtitle, badge chip. */
export function ogCardSvg(card: OgCard, site: SiteDoc): string {
  const bg = site.app?.backgroundColor ?? "#14110f";
  const accent = site.app?.accentColor ?? site.app?.themeColor ?? "#d9482b";
  const titleLines = wrap(card.title, 26, 3);
  const subtitleLines = card.subtitle ? wrap(card.subtitle, 52, 2) : [];
  const titleY = 250;
  const title = titleLines
    .map((line, at) => `<text x="80" y="${titleY + at * 84}" font-family="IBM Plex Sans" font-size="72" font-weight="600" fill="#f2ede4">${esc(line)}</text>`)
    .join("");
  const subY = titleY + titleLines.length * 84 + 24;
  const subtitle = subtitleLines
    .map((line, at) => `<text x="80" y="${subY + at * 46}" font-family="IBM Plex Sans" font-size="34" fill="#a89c8d">${esc(line)}</text>`)
    .join("");
  const badge = card.badge
    ? `<rect x="80" y="510" rx="10" width="${card.badge.length * 22 + 48}" height="64" fill="${esc(accent)}"/>
       <text x="104" y="554" font-family="IBM Plex Sans" font-size="34" font-weight="600" fill="#fffdf9">${esc(card.badge)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${esc(bg)}"/>
  <rect x="0" y="0" width="1200" height="12" fill="${esc(accent)}"/>
  <text x="80" y="150" font-family="IBM Plex Sans" font-size="30" letter-spacing="6" fill="${esc(accent)}">// ${esc(card.kicker.toUpperCase())}</text>
  ${title}${subtitle}${badge}
  <circle cx="1080" cy="560" r="34" fill="${esc(accent)}" opacity="0.9"/>
</svg>`;
}

export async function renderPng(svg: string): Promise<Uint8Array> {
  if (!ready) throw new Error("resvg wasm not initialized");
  await ready;
  const font = await loadFont();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    ...(font ? { font: { fontBuffers: [font], defaultFontFamily: "IBM Plex Sans", loadSystemFonts: false } } : {}),
  });
  return resvg.render().asPng();
}

/** The generated favicon: a lettermark from site.app — overridable with raw SVG in config. */
export function faviconSvg(displayName: string, site: SiteDoc & { app?: { favicon?: string } }): string {
  if (site.app?.favicon) return site.app.favicon;
  const accent = site.app?.accentColor ?? site.app?.themeColor ?? "#d9482b";
  const letter = (site.app?.shortName ?? displayName ?? "S").trim().charAt(0).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${esc(accent)}"/>
  <text x="32" y="44" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="36" font-weight="700" fill="#fffdf9">${esc(letter)}</text>
</svg>`;
}
