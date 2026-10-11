import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";

import { applySchema, databaseUrl } from "../src/db.ts";
import { freshTestPool } from "./helpers/database.ts";

let pool: pg.Pool;

before(async () => {
  pool = await freshTestPool(databaseUrl());
});

after(async () => {
  await pool.end();
});

/** Postgres error text is localised, so assert the SQLSTATE code, not the words. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

async function rejectsWithSqlState(
  sqlState: string,
  run: () => Promise<unknown>,
) {
  await assert.rejects(run, (err: unknown) => {
    assert.equal((err as { code?: string }).code, sqlState);
    return true;
  });
}

/** A session with no rounds of its own, to hang rounds off. */
async function newSession(): Promise<string> {
  const session = await pool.query(
    "INSERT INTO sessions DEFAULT VALUES RETURNING id",
  );
  return session.rows[0]!.id as string;
}

describe("applying the schema and the characters", () => {
  it("is safe to apply twice, and leaves six characters", async () => {
    await applySchema(pool, true);
    await applySchema(pool, true);

    const { rows } = await pool.query("SELECT name FROM targets ORDER BY id");
    assert.equal(rows.length, 6);
  });

  it("updates a character's box in place instead of adding a second character", async () => {
    await pool.query(
      "UPDATE targets SET x = 0.999, y = 0.999, w = 0.001, h = 0.001 WHERE name = $1",
      ["Spike, the shark"],
    );

    await applySchema(pool, true);

    const { rows } = await pool.query(
      "SELECT x, y, w, h FROM targets WHERE name = $1",
      ["Spike, the shark"],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.x), 0.14);
    assert.equal(Number(rows[0]!.y), 0.17);
    assert.equal(Number(rows[0]!.w), 0.075);
    assert.equal(Number(rows[0]!.h), 0.085);
  });

  it("refuses a character box that falls outside the picture", async () => {
    await rejectsWithSqlState(CHECK_VIOLATION, () =>
      pool.query(
        `INSERT INTO targets (name, x, y, w, h) VALUES ('Off the edge', 0.9, 0.5, 0.5, 0.2)`,
      ),
    );
  });

  it("lets the database set the round's start time", async () => {
    const { rows } = await pool.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'rounds' AND column_name = 'started_at'`,
    );
    assert.match(rows[0]!.column_default, /now\(\)/i);
  });

  it("keeps a character's box in fractions a float32 cannot hold", async () => {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'targets' AND column_name = 'x'`,
    );
    assert.equal(rows[0]!.data_type, "double precision");
  });

  it("accepts a box flush with the edge of the picture", async () => {
    // As float32 this is 0.99900001 + 0.00099999 = 1.0000000149, and the
    // database rejects a character that sits exactly against the edge.
    await pool.query(
      `INSERT INTO targets (name, x, y, w, h)
       VALUES ('Flush to the edge', 0.999, 0.999, 0.001, 0.001)`,
    );
    const { rows } = await pool.query(
      "SELECT 1 FROM targets WHERE name = $1",
      ["Flush to the edge"],
    );
    assert.equal(rows.length, 1);
    await pool.query("DELETE FROM targets WHERE name = $1", [
      "Flush to the edge",
    ]);
  });

  it("refuses a second unfinished round for the same session", async () => {
    const id = await newSession();

    await pool.query("INSERT INTO rounds (session_id) VALUES ($1)", [id]);

    await rejectsWithSqlState(UNIQUE_VIOLATION, () =>
      pool.query("INSERT INTO rounds (session_id) VALUES ($1)", [id]),
    );
  });

  it("lets a session carry a tag, and keeps it to one a row can show", async () => {
    const id = await newSession();

    await pool.query("UPDATE sessions SET tag = $2 WHERE id = $1", [id, "Ada"]);
    const { rows } = await pool.query("SELECT tag FROM sessions WHERE id = $1", [
      id,
    ]);
    assert.equal(rows[0]!.tag, "Ada");

    // The application checks a tag before it arrives; the database says the
    // same thing anyway, so the invariant holds however the row was written.
    await rejectsWithSqlState(CHECK_VIOLATION, () =>
      pool.query("UPDATE sessions SET tag = $2 WHERE id = $1", [id, "a".repeat(17)]),
    );
    await rejectsWithSqlState(CHECK_VIOLATION, () =>
      pool.query("UPDATE sessions SET tag = '' WHERE id = $1", [id]),
    );
  });

  it("lets a session have no tag at all", async () => {
    const id = await newSession();

    const { rows } = await pool.query("SELECT tag FROM sessions WHERE id = $1", [
      id,
    ]);
    assert.equal(rows[0]!.tag, null, "a tag is something the player chooses, not something they have");
  });

  it("lets a session play again once its round is finished", async () => {
    const id = await newSession();
    await pool.query(
      "INSERT INTO rounds (session_id, finished_at, elapsed_ms) VALUES ($1, now(), 1000)",
      [id],
    );

    await pool.query("INSERT INTO rounds (session_id) VALUES ($1)", [id]);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM rounds WHERE session_id = $1",
      [id],
    );
    assert.equal(rows[0]!.n, 2, "a finished round is kept, and does not block another");
  });
});
