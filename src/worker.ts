import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { setDb, type AppDb } from "./db/registry";
import { setInstances } from "./server/runtime-config";
import type { ServiceInstance } from "hono-aep-cms";
import servicesArtifact from "../dist/services.json";
import { setEmbedder } from "./server/embed";
import { setBlobs } from "./server/blobs";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { initResvg } from "./server/site-og";
import { createStorage } from "unstorage";
import r2Driver from "unstorage/drivers/cloudflare-r2-binding";

/**
 * The Cloudflare Worker entry: install D1 into the drizzle seam and the
 * bundled service instances, wire the Workers-AI embedder, then reuse the
 * runtime-neutral handler (./server/app). Built once per isolate.
 */

type Env = {
  DB: unknown;
  AI?: { run: (model: string, input: { text: string[] }) => Promise<{ data: number[][] }> };
  MEDIA?: unknown; // R2 bucket binding — media bytes (media.md)
  BETTER_AUTH_URL?: string;
};

let handlePromise: Promise<(request: Request) => Promise<Response>> | undefined;
let tickPromise: Promise<() => Promise<unknown>> | undefined;

async function boot(env: Env): Promise<{
  handle: (request: Request) => Promise<Response>;
  tick: () => Promise<unknown>;
}> {
  setDb(drizzle(env.DB as Parameters<typeof drizzle>[0], { schema }) as unknown as AppDb);
  setInstances(servicesArtifact as ServiceInstance[]);
  initResvg(resvgWasm); // OG-card rasterization (site-og.ts)
  // Real semantic search: @cf/baai/bge-m3 over the AI binding (Workers AI).
  if (env.AI) {
    setEmbedder(async (text: string) => {
      const out = await env.AI!.run("@cf/baai/bge-m3", { text: [text] });
      return out.data[0]!;
    });
  }
  if (env.MEDIA) {
    setBlobs(createStorage({ driver: r2Driver({ binding: env.MEDIA as never }) }));
  }
  const { createHandler } = await import("./server/app");
  const { jobs } = await import("./server/services");
  // The cron tick also sweeps abandoned connect flows: one that completed
  // consent but was never claimed holds a live provider access token until it
  // expires, and nothing else deletes it (connect.md §5.11).
  const { sweepExpiredFlows } = await import("./server/connect");
  return {
    handle: createHandler(),
    tick: async () => {
      await sweepExpiredFlows();
      return jobs ? await jobs.tick() : undefined;
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    handlePromise ??= boot(env).then((b) => {
      tickPromise = Promise.resolve(b.tick);
      return b.handle;
    });
    return (await handlePromise)(request);
  },
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    handlePromise ??= boot(env).then((b) => {
      tickPromise = Promise.resolve(b.tick);
      return b.handle;
    });
    await handlePromise;
    const tick = await tickPromise!;
    ctx.waitUntil(tick());
  },
};
