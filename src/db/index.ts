import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";
import { setDb, type AppDb } from "./registry";

// The Bun entrypoint for the database seam: importing this module opens the
// local SQLite file and installs it as the app db.

export const databasePath = process.env.DATABASE_PATH ?? "data/baas.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });

const sqlite = new Database(databasePath);
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, { schema });
setDb(db as unknown as AppDb);
