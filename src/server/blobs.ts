import type { Storage } from "unstorage";

/**
 * The blob seam (media.md): the runtime installs its byte store before the
 * server body evaluates — Bun uses the filesystem (data/media), the Worker
 * an R2 binding. Same pattern as the db seam and the embedder.
 */
let blobs: Storage | null = null;

export const setBlobs = (storage: Storage): void => {
  blobs = storage;
};
export const getBlobs = (): Storage | null => blobs;
