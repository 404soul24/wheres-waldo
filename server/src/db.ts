import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db");

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 4 });
}

/**
 * Apply the schema, and optionally the characters. Both are written to be safe
 * to re-run, so applying them to a live database is a no-op for anything that
 * already matches.
 */
export async function applySchema(pool: pg.Pool, seed = false): Promise<void> {
  await pool.query(await readFile(join(DB_DIR, "schema.sql"), "utf8"));
  if (seed) {
    await pool.query(await readFile(join(DB_DIR, "seed.sql"), "utf8"));
  }
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}
