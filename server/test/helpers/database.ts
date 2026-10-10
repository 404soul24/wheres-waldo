import pg from "pg";

import { applySchema, createPool } from "../../src/db.ts";

const TEST_DATABASE = "wheres_waldo_test";

export function testDatabaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

/**
 * A pool on a database of the test suite's own, so a misconfigured
 * DATABASE_URL can never make the suite drop the application's data. The
 * database is created once; only the rows are reset per run.
 */
export async function freshTestPool(baseUrl: string): Promise<pg.Pool> {
  const url = testDatabaseUrl(baseUrl);
  const admin = createPool(baseUrl);
  const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    TEST_DATABASE,
  ]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  }
  await admin.end();

  const pool = createPool(url);
  await applySchema(pool, true);
  await resetRoundData(pool);
  return pool;
}

/** Empty the tables a round writes to, leaving the seeded characters alone. */
export async function resetRoundData(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE sessions, rounds, finds RESTART IDENTITY CASCADE");
}
