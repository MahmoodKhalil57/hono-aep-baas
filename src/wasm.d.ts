// Wrangler bundles .wasm imports as CompiledWasm modules (ESM format).
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
