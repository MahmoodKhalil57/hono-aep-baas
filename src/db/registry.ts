import { createDbSeam } from "hono-aep-drizzle";
import type * as schema from "./schema";

/** The database seam: src/db/index.ts installs bun:sqlite at import time. */
export type AppDb = ReturnType<typeof createDbSeam<typeof schema>>["db"];

const seam = createDbSeam<typeof schema>();
export const db: AppDb = seam.db;
export const setDb = seam.setDb;
