import type { Embedder } from "hono-aep-search";

/** The embedder seam: the Worker installs a Workers-AI call here; the Bun
 *  entry leaves it undefined (search stays lexical). services.ts reads it. */
let embedder: Embedder | undefined;
export const setEmbedder = (fn: Embedder): void => {
  embedder = fn;
};
export const getEmbedder = (): Embedder | undefined => embedder;
