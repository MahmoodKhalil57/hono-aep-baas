import tailwind from "bun-plugin-tailwind";

/**
 * Bundle the dogfooded studio (studio-app/) into dist/studio-assets/,
 * served by the Worker via Static Assets (wrangler `assets`) — /studio
 * resolves to studio.html there. Run before `wrangler deploy`.
 *
 * The dedupe plugin is load-bearing: node_modules carries NESTED copies
 * of the shared packages (hono-aep-studio/node_modules/hono-aep-ui, …).
 * Two hono-aep-ui module instances mean two AepUiProvider React contexts
 * — the Puck editor would throw "outside the provider". Forcing every
 * importer to the root copy keeps one context identity (the same problem
 * richPetShop's fix-react-links.sh solves at the symlink layer).
 */

const root = new URL("..", import.meta.url).pathname;
const SHARED =
  /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client|react-hook-form|react-router|hono-aep-ui|hono-aep-ui\/admin|hono-aep-blocks|hono-aep\/client)$/;

const dedupe: import("bun").BunPlugin = {
  name: "dedupe-shared",
  setup(build) {
    build.onResolve({ filter: SHARED }, (args) => ({ path: Bun.resolveSync(args.path, root) }));
  },
};

const result = await Bun.build({
  entrypoints: ["studio-app/studio.html"],
  outdir: "dist/studio-assets",
  plugins: [dedupe, tailwind],
  minify: true,
  splitting: true,
  sourcemap: "linked",
  publicPath: "/",
  define: { "process.env.NODE_ENV": '"production"' },
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// Sourcemaps stay local: uploading ~6 MB of maps triples deploy time.
await Bun.write("dist/studio-assets/.assetsignore", "*.map\n");
const total = result.outputs.reduce((sum, artifact) => sum + artifact.size, 0);
console.log(
  `studio → dist/studio-assets: ${result.outputs.length} files, ${(total / 1024 / 1024).toFixed(2)} MB total`,
);
for (const artifact of result.outputs.filter((a) => a.size > 200_000)) {
  console.log(`  ${(artifact.size / 1024).toFixed(0)} KB  ${artifact.path.split("/").pop()}`);
}
