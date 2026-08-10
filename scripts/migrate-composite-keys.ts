/**
 * One-shot migration: parented definition tables key on (parent, id).
 *
 * They were created with a bare `id` primary key, which made a slug
 * GLOBALLY unique across tenants — two projects declaring `products` were
 * ONE row, so the second project's write destroyed the first's definition
 * (orphaning its data, which lives correctly scoped in json_rows).
 *
 * SQLite cannot ALTER a primary key, so each table is rebuilt. The new DDL
 * is DERIVED from the table's own `sqlite_master` definition — move the
 * primary key off `id` and onto (parent, id), change nothing else — so the
 * migration cannot drift from the real column set.
 *
 * Usage:
 *   bun scripts/migrate-composite-keys.ts <db.sqlite>          # print SQL
 *   bun scripts/migrate-composite-keys.ts <db.sqlite> --apply  # and run it
 *   …--schema <schema.gen.ts>   # another app's generated schema (the
 *                                 key change affects every consumer app)
 * The printed SQL is what `wrangler d1 execute --file` applies to D1.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/**
 * The table list comes from the GENERATED schema, which is the authority on
 * which resources are parented — hand-listing them is how `submissions` got
 * missed. Auth/suite tables (session, api_key, …) are deliberately excluded:
 * their `id` IS globally unique and must stay a bare primary key.
 */
const compositeTables = (): { table: string; parent: string }[] => {
  const flag = process.argv.indexOf("--schema");
  const schemaPath = flag >= 0 ? process.argv[flag + 1]! : new URL("../src/db/schema.gen.ts", import.meta.url);
  const source = readFileSync(schemaPath as string & URL, "utf8");
  const out: { table: string; parent: string }[] = [];
  for (const block of source.split(/(?=export const \w+ = sqliteTable\()/)) {
    const name = /export const \w+ = sqliteTable\("(\w+)"/.exec(block)?.[1];
    const parent = /primaryKey\(\{ columns: \[table\.(\w+), table\.id\] \}\)/.exec(block)?.[1];
    if (name && parent) out.push({ table: name, parent });
  }
  return out;
};

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/migrate-composite-keys.ts <db.sqlite> [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const db = new Database(path);
// CHILDREN FIRST. The generator emits parents first, but a rebuild must
// drop a child's FK before its parent's `id` stops being unique — otherwise
// the old child FK re-binds to the new parent mid-transaction and the
// constraint check fails at commit.
const SPEC = compositeTables().reverse();
const TABLES = SPEC.map((entry) => entry.table);
console.error("parented tables:", TABLES.join(", ") || "(none)");

const statements: string[] = [];
for (const table of TABLES) {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | null;
  if (!row?.sql) continue; // absent on a fresh database

  const parent = SPEC.find((entry) => entry.table === table)!.parent;
  if (/PRIMARY KEY \(/i.test(row.sql)) {
    console.error(`-- ${table}: already composite; skipped`);
    continue;
  }

  // A FOREIGN KEY must reference a UNIQUE/PRIMARY key. Once a parent table
  // keys on (parent, id), its bare `id` is no longer unique, so any child
  // FK pointing at it becomes unsatisfiable — SQLite accepts the DDL and
  // then fails the constraint check at commit. Strip exactly those; FKs to
  // root tables (projects.id, still globally unique) are kept. The resource
  // tree is enforced in the storage scope and the ownership hooks either way.
  const strippedFk = row.sql.replace(
    new RegExp(`,?\\s*FOREIGN KEY \\([^)]*\\) REFERENCES \`?(?:${TABLES.join("|")})\`?\\([^)]*\\)(?: ON \\w+ \\w+ \\w+)*`, "gi"),
    "",
  );

  // Same shape, minus the bare primary key, plus the composite one.
  const rebuilt = strippedFk
    // SQLite re-emits DDL with DOUBLE quotes after an ALTER…RENAME, so a
    // backtick-only pattern silently fails to rename and the rebuild then
    // collides with the live table.
    .replace(/CREATE TABLE\s+["`]?\w+["`]?/, `CREATE TABLE \`${table}__new\``)
    // Handles `id text PRIMARY KEY NOT NULL` and the integer
    // AUTOINCREMENT form. Losing AUTOINCREMENT is safe: nextId() derives
    // the next value with max(id)+1 rather than relying on the sequence.
    .replace(/`?\bid`? (\w+) PRIMARY KEY(?: AUTOINCREMENT)? NOT NULL/i, "`id` $1 NOT NULL")
    .replace(/\)\s*$/, `,\n\tPRIMARY KEY (\`${parent}\`, \`id\`)\n)`);

  const columns = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((column) => `\`${column.name}\``)
    .join(", ");

  statements.push(
    `DROP TABLE IF EXISTS \`${table}__new\`;`,
    `${rebuilt};`,
    `INSERT INTO \`${table}__new\` (${columns}) SELECT ${columns} FROM \`${table}\`;`,
    `DROP TABLE \`${table}\`;`,
    `ALTER TABLE \`${table}__new\` RENAME TO \`${table}\`;`,
  );
}

const sql = statements.join("\n");
if (!apply) {
  console.log(sql);
  process.exit(0);
}

const counts = (): Record<string, number | string> =>
  Object.fromEntries(
    TABLES.map((table) => {
      try {
        return [table, (db.query(`SELECT COUNT(*) n FROM \`${table}\``).get() as { n: number }).n];
      } catch {
        return [table, "absent"];
      }
    }),
  );

const before = counts();
db.exec("PRAGMA foreign_keys=OFF;");
db.exec(sql);
const after = counts();
console.error("before:", JSON.stringify(before));
console.error("after :", JSON.stringify(after));
for (const table of TABLES) {
  if (before[table] !== after[table]) {
    console.error(`!! ${table}: ${before[table]} -> ${after[table]} (ROW LOSS)`);
    process.exit(1);
  }
}
console.error("migration applied; every row preserved.");
