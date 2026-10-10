import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type pg from "pg";

import { createApp } from "../src/app.ts";
import { databaseUrl } from "../src/db.ts";
import { freshTestPool, resetRoundData } from "./helpers/database.ts";
import { visitor } from "./helpers/visitor.ts";

process.env.SESSION_SECRET ??= "test-secret-not-used-in-production";
process.env.NODE_ENV = "test";

let pool: pg.Pool;
let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

before(async () => {
  pool = await freshTestPool(databaseUrl());
  server = createApp(pool).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await resetRoundData(pool);
});

/** The board as a visitor who never played sees it. */
function stranger() {
  return visitor(baseUrl, pool).board();
}

/** A finished round worth `ms`, played by a session that only exists to hold it. */
async function score(ms: number) {
  const session = randomUUID();
  await pool.query("INSERT INTO sessions (id) VALUES ($1)", [session]);
  await pool.query(
    `INSERT INTO rounds (session_id, finished_at, elapsed_ms)
     VALUES ($1, now(), $2)`,
    [session, ms],
  );
  return session;
}

/** A visitor who has played a round, with the session behind their cookie. */
async function player() {
  const me = visitor(baseUrl, pool);
  await me.start();
  const { rows } = await pool.query("SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1");
  return { me, session: rows[0]!.id as string };
}

/** Record a score on this player's round and nothing else. */
async function giveScore(session: string, ms: number) {
  await pool.query(
    "UPDATE rounds SET finished_at = now(), elapsed_ms = $2 WHERE session_id = $1 AND finished_at IS NULL",
    [session, ms],
  );
}

describe("the leaderboard", () => {
  it("lists the fastest scores first", async () => {
    await score(40_000);
    await score(10_000);
    await score(25_000);

    const { res, body } = await stranger();

    assert.equal(res.status, 200);
    assert.deepEqual(
      body.entries.map((e) => e.elapsedMs),
      [10_000, 25_000, 40_000],
    );
  });

  it("shows no more than ten scores", async () => {
    for (let i = 0; i < 12; i++) await score((i + 1) * 1_000);

    const { body } = await stranger();

    assert.equal(body.entries.length, 10);
    assert.equal(body.entries[0]!.elapsedMs, 1_000, "and the ten that show are the ten fastest");
  });

  it("leaves out rounds nobody finished", async () => {
    await score(5_000);
    const live = randomUUID();
    await pool.query("INSERT INTO sessions (id) VALUES ($1)", [live]);
    await pool.query("INSERT INTO rounds (session_id) VALUES ($1)", [live]);

    const { body } = await stranger();

    assert.deepEqual(
      body.entries.map((e) => e.elapsedMs),
      [5_000],
      "an abandoned round is nobody's score",
    );
  });

  it("says when nobody has finished a round yet", async () => {
    const { res, body } = await stranger();

    assert.equal(res.status, 200);
    assert.deepEqual(body.entries, []);
    assert.equal(body.yours, null);
  });

  it("counts a session once, on its best score", async () => {
    const session = await score(50_000);
    await pool.query("INSERT INTO rounds (session_id, finished_at, elapsed_ms) VALUES ($1, now(), $2)", [session, 30_000]);
    await pool.query("INSERT INTO rounds (session_id, finished_at, elapsed_ms) VALUES ($1, now(), $2)", [session, 90_000]);

    const { body } = await stranger();

    assert.deepEqual(
      body.entries.map((e) => e.elapsedMs),
      [30_000],
      "one row for the session, and it is the better of its rounds",
    );
  });

  it("marks the player's own row and no other", async () => {
    await score(20_000);
    const { me, session } = await player();
    await giveScore(session, 45_000);

    const { body } = await me.board();

    assert.deepEqual(
      body.entries.map((e) => e.you),
      [false, true],
    );
  });

  it("still knows the player's score when it missed the board", async () => {
    for (let i = 0; i < 10; i++) await score((i + 1) * 1_000);
    const { me, session } = await player();
    await giveScore(session, 60_000);

    const { body } = await me.board();

    assert.equal(body.entries.length, 10);
    assert.equal(body.entries.some((e) => e.you), false, "no row of theirs shows");
    assert.equal(body.yours?.elapsedMs, 60_000, "but the view is still told their time");
  });

  it("says a player has no score before they finish anything", async () => {
    const { me } = await player();

    const { body } = await me.board();

    assert.equal(body.yours, null);
  });

  it("answers a visitor with no session at all", async () => {
    await score(12_000);

    const { body } = await stranger();

    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0]!.you, false, "nobody's row is anybody's");
  });

  it("tells nobody who anyone is", async () => {
    await score(12_000);

    const { body } = await stranger();

    assert.deepEqual(
      Object.keys(body.entries[0]!).sort(),
      ["elapsedMs", "finishedAt", "session", "you"],
      "a score, when it was set, and an opaque handle: nothing else",
    );
  });

  it("counts a session that played twice over HTTP, once", async () => {
    const { me, session } = await player();
    await giveScore(session, 40_000);
    await me.playAgain();
    await giveScore(session, 15_000);

    const { body } = await me.board();

    assert.deepEqual(
      body.entries.map((e) => e.elapsedMs),
      [15_000],
      "two rounds, one row, and it is the faster",
    );
    assert.equal(body.entries[0]!.you, true);
  });
});