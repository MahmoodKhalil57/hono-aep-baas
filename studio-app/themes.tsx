import { useEffect, useMemo, useState } from "react";
import { v1 as client } from "./client";
import { TokenValueEditor } from "hono-aep-studio/src/theme-editor/token-inputs";
import { ContrastPanel } from "hono-aep-studio/src/theme-editor/contrast";

/**
 * Theme editing with the studio package's real token widgets: color
 * swatches, dimension sliders, font pickers, shadow builders — per token,
 * per scope block — plus the WCAG ContrastPanel. Edits are surgical string
 * replacements inside the original CSS, so non-token content (@imports,
 * extra rules, comments) survives Visual editing — an improvement over the
 * classic page. Apply PUTs {css} through the public contract as ever.
 */

type Block = { selector: string; bodyStart: number; bodyEnd: number };
type TokenRef = { block: number; name: string; value: string };

function parseBlocks(css: string): Block[] {
  const blocks: Block[] = [];
  for (const match of css.matchAll(/(^|\n)\s*((?::root|\.dark)[^{]*)\{([^}]*)\}/g)) {
    const bodyStart = match.index! + match[0].indexOf("{") + 1;
    blocks.push({ selector: match[2]!.trim(), bodyStart, bodyEnd: bodyStart + match[3]!.length });
  }
  return blocks;
}

function parseTokens(css: string, blocks: Block[]): TokenRef[] {
  const tokens: TokenRef[] = [];
  blocks.forEach((block, at) => {
    const body = css.slice(block.bodyStart, block.bodyEnd);
    for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      tokens.push({ block: at, name: match[1]!, value: match[2]!.trim() });
    }
  });
  return tokens;
}

/** Replace one token's value inside its own block; everything else is untouched. */
function replaceToken(css: string, blocks: Block[], token: TokenRef, next: string): string {
  const block = blocks[token.block]!;
  const body = css.slice(block.bodyStart, block.bodyEnd);
  const pattern = new RegExp(`(--${token.name}\\s*:\\s*)[^;]+;`);
  const patched = body.replace(pattern, `$1${next};`);
  return css.slice(0, block.bodyStart) + patched + css.slice(block.bodyEnd);
}

type ThemeRow = { path: string; css?: string };

export function ThemesTab({ pid, slug }: { pid: string; slug?: string }) {
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  useEffect(() => {
    void client.list<ThemeRow>(`projects/${pid}/themes`).then(({ results }) => setThemes(results));
  }, [client, pid]);
  if (slug) return <ThemeEditor pid={pid} slug={slug} />;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Served at /v1/projects/{pid.slice(0, 8)}…/theme.css</p>
        <button
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          onClick={() => {
            const name = prompt("New theme slug?");
            if (!name) return;
            void client
              .apply(`projects/${pid}/themes/${name}`, { css: ":root {\n  --primary: oklch(0.55 0.17 32);\n}\n" })
              .then(() => { location.hash = `/themes/${name}`; });
          }}
        >
          New theme
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {themes.map((theme) => {
          const name = theme.path.split("/").pop()!;
          return (
            <li key={theme.path}>
              <a href={`#/themes/${name}`} className="block rounded-lg border bg-card px-4 py-3 font-mono text-sm hover:bg-accent">
                {name}
              </a>
            </li>
          );
        })}
        {!themes.length && <p className="text-sm text-muted-foreground">No themes yet.</p>}
      </ul>
    </section>
  );
}

function ThemeEditor({ pid, slug }: { pid: string; slug: string }) {
  const [css, setCss] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    setCss(null);
    void client.get<ThemeRow>(`projects/${pid}/themes/${slug}`).then((row) => setCss(row.css ?? ""));
  }, [client, pid, slug]);

  const blocks = useMemo(() => (css === null ? [] : parseBlocks(css)), [css]);
  const tokens = useMemo(() => (css === null ? [] : parseTokens(css, blocks)), [css, blocks]);
  const contrastVars = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const token of tokens) if (blocks[token.block]?.selector.startsWith(":root")) vars[token.name] ??= token.value;
    return vars;
  }, [tokens, blocks]);

  if (css === null) return <p className="text-sm text-muted-foreground">Loading {slug}…</p>;
  const apply = () =>
    void client.apply(`projects/${pid}/themes/${slug}`, { css }).then(
      () => setNote("Theme applied — live at theme.css."),
      (thrown: unknown) => setNote(thrown instanceof Error ? thrown.message : "Refused"),
    );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm">themes/{slug}</h2>
        <div className="flex gap-2">
          <button onClick={() => setRaw(!raw)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
            {raw ? "Visual" : "Raw CSS"}
          </button>
          <a href="#/themes" className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Back</a>
          <button onClick={apply} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
            Apply theme
          </button>
        </div>
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {raw ? (
        <textarea
          value={css}
          onChange={(event) => setCss(event.target.value)}
          rows={24}
          spellCheck={false}
          className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="flex flex-col gap-5">
            {blocks.map((block, at) => (
              <div key={at} className="rounded-lg border bg-card p-4">
                <p className="kicker mb-3">{block.selector}</p>
                <div className="flex flex-col gap-2">
                  {tokens
                    .filter((token) => token.block === at)
                    .map((token) => (
                      <div key={token.name} className="grid grid-cols-[12rem_1fr] items-center gap-3">
                        <code className="truncate text-xs text-muted-foreground">--{token.name}</code>
                        <TokenValueEditor
                          name={token.name}
                          value={token.value}
                          onChange={(next) => setCss(replaceToken(css, blocks, token, next))}
                        />
                      </div>
                    ))}
                  {!tokens.some((token) => token.block === at) && (
                    <p className="text-xs text-muted-foreground">No tokens in this block.</p>
                  )}
                </div>
              </div>
            ))}
            {!blocks.length && (
              <p className="text-sm text-muted-foreground">No :root/.dark blocks found — use Raw CSS.</p>
            )}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="kicker mb-3">wcag contrast</p>
            <ContrastPanel vars={contrastVars} />
          </div>
        </div>
      )}
    </section>
  );
}
