import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type pg from "pg";

import { createApp } from "../src/app.ts";
import { databaseUrl } from "../src/db.ts";
import { freshTestPool, resetRoundData } from "./helpers/database.ts";
import { CHARACTERS, visitor } from "./helpers/visitor.ts";

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

type StoredRound = {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  elapsed_ms: number | null;
};

const roundRow = async (id?: string) =>
  (await pool.query(
    id
      ? "SELECT * FROM rounds WHERE id = $1"
      : "SELECT * FROM rounds ORDER BY started_at DESC LIMIT 1",
    id ? [id] : [],
  )).rows[0] as StoredRound;

const findCount = async () =>
  (await pool.query("SELECT count(*)::int AS n FROM finds")).rows[0]!
    .n as number;

/** A player with a round under way who has found every character but the last. */
async function oneFromTheEnd() {
  const me = visitor(baseUrl, pool);
  await me.start();
  for (const name of CHARACTERS.slice(0, -1)) await me.find(name);
  return me;
}

/** A player who has found all six. */
async function finished() {
  const me = await oneFromTheEnd();
  const { body } = await me.find(CHARACTERS[CHARACTERS.length - 1]!);
  return { me, round: body.round! };
}

describe("finishing a round", () => {
  it("ends the round the moment the last character is found", async () => {
    const me = await oneFromTheEnd();

    const { res, body } = await me.find(CHARACTERS[CHARACTERS.length - 1]!);

    assert.equal(res.status, 200);
    assert.equal(body.hit, true);
    assert.equal(body.characters.every((c) => c.found), true);

    const round = await roundRow();
    assert.ok(round.finished_at, "the round is finished");
    assert.ok(round.elapsed_ms !== null, "and it has a score");
  });

  it("reports the score on the guess that finished the round", async () => {
    const me = await oneFromTheEnd();

    const { body } = await me.find(CHARACTERS[CHARACTERS.length - 1]!);

    assert.ok(body.round, "the finishing answer carries the round");
    assert.ok(body.round.finishedAt, "and it says when the round ended");
    const stored = await roundRow();
    const score = body.round.elapsedMs;
    assert.ok(score !== null, "and it is a score, not an absence of one");
    assert.equal(score, stored.elapsed_ms, "the score is the one the database recorded");
    assert.ok(
      Math.abs(score - (stored.finished_at!.getTime() - stored.started_at.getTime())) <= 1,
      "and it is that round's own start to its own end, to the millisecond",
    );
  });

  it("computes the score from the round's start, never from what the client sent", async () => {
    const me = await oneFromTheEnd();
    await pool.query("UPDATE rounds SET started_at = now() - interval '90 seconds'");
    const startedAt = (await roundRow()).started_at;

    // A client claiming a score of its own, and a finishing time of its own.
    const { body } = await me.find(CHARACTERS[CHARACTERS.length - 1]!, {
      elapsedMs: 1,
      finishedAt: "1999-01-01T00:00:00.000Z",
    });

    assert.ok(
      body.round!.elapsedMs! >= 90_000,
      `a score of ${body.round!.elapsedMs} did not come from a client claiming 1`,
    );
    assert.ok(
      body.round!.elapsedMs! < 120_000,
      "and it is a round that took ninety seconds, not an hour",
    );
    assert.ok(
      Date.parse(body.round!.finishedAt!) - startedAt.getTime() >= 90_000,
      "the finish is the server's now(), not the client's 1999",
    );
  });

  it("records no score for a session that never finishes", async () => {
    await oneFromTheEnd();

    const round = await roundRow();
    assert.equal(round.finished_at, null, "an unfinished round has no end");
    assert.equal(round.elapsed_ms, null, "and no score");
  });

  it("does not finish the round while a character is still missing", async () => {
    const me = await oneFromTheEnd();

    // Misses are quiet and cost nothing: the clock is all that passes.
    const { res } = await me.guess({ name: CHARACTERS[1], x: 0.5, y: 0.5 });
    assert.equal(res.status, 200);

    assert.equal((await roundRow()).finished_at, null);
  });

  it("keeps the score against the round across a refresh", async () => {
    const { me, round: scored } = await finished();

    const { body } = await me.start();

    assert.equal(body.round.id, scored.id);
    assert.equal(body.round.finishedAt, scored.finishedAt);
    assert.equal(body.round.elapsedMs, scored.elapsedMs);
    assert.equal(
      (await roundRow(scored.id)).elapsed_ms,
      scored.elapsedMs,
      "and it is still on the row",
    );
  });

  it("refuses a guess at a round that is already over", async () => {
    const { me, round: scored } = await finished();
    const before = (await roundRow(scored.id)).elapsed_ms;

    const { res } = await me.find(CHARACTERS[0]!);

    assert.equal(res.status, 409, "the round is over, so the guess is refused");
    assert.equal((await roundRow(scored.id)).elapsed_ms, before, "the score is untouched");
    assert.equal(await findCount(), 6, "a refused guess records nothing");
  });

  it("settles a round left found but unfinished, rather than stranding it", async () => {
    const me = await oneFromTheEnd();
    const { body: live } = await me.start();
    // Every character found, and the round never finished: what a connection
    // dying between recording the find and finishing the round would leave.
    await pool.query(
      "INSERT INTO finds (round_id, target_id) SELECT $1, id FROM targets ON CONFLICT DO NOTHING",
      [live.round.id],
    );

    const { body } = await me.start();

    assert.ok(body.round.finishedAt, "the round is over the next time it is asked for");
    assert.equal(typeof body.round.elapsedMs, "number");
    assert.equal(
      (await roundRow(live.round.id)).elapsed_ms,
      body.round.elapsedMs,
    );
  });
});

describe("starting a new round", () => {
  it("gives the same six characters afresh, with a clock of its own", async () => {
    const { me, round: first } = await finished();

    const { body } = await me.playAgain();

    assert.notEqual(body.round.id, first.id, "a new round is a new round");
    assert.deepEqual(
      body.characters.map((c) => c.name),
      CHARACTERS,
      "the same six, in the same order",
    );
    assert.equal(
      body.characters.every((c) => c.found === false),
      true,
      "and none of them found yet",
    );
    assert.equal(body.round.finishedAt, null);
    assert.equal(body.round.elapsedMs, null);
    assert.ok(
      Date.parse(body.round.startedAt) >= Date.parse(first.startedAt),
      "the new clock does not start before the old one",
    );
  });

  it("leaves the finished round and its score exactly as they were", async () => {
    const { me, round: first } = await finished();

    await me.playAgain();

    assert.equal(
      (await roundRow(first.id)).elapsed_ms,
      first.elapsedMs,
      "starting again never erases the score just beaten",
    );
  });

  it("can be finished in its own right", async () => {
    const { me, round: first } = await finished();
    const { body: second } = await me.playAgain();

    const { body } = await me.find(CHARACTERS[0]!);

    assert.equal(body.round!.id, second.round.id, "the guess scores the new round");
    assert.equal(
      (await roundRow(first.id)).elapsed_ms,
      first.elapsedMs,
      "and the old score stands",
    );
  });

  it("resumes an unfinished round rather than replacing it", async () => {
    const me = visitor(baseUrl, pool);
    await me.start();
    await me.find(CHARACTERS[0]!);

    const { body } = await me.start();

    assert.equal(body.characters.find((c) => c.name === CHARACTERS[0])?.found, true);
    assert.equal(body.round.finishedAt, null);
    assert.equal(await findCount(), 1, "and it did not start over");
  });

  it("resumes one round, not two, for two requests made at once", async () => {
    const me = visitor(baseUrl, pool);
    await me.start();

    const [a, b] = await Promise.all([me.start(), me.start()]);

    assert.equal(a.body.round.id, b.body.round.id);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM rounds");
    assert.equal(rows[0]!.n, 1, "one session, one round");
  });

  it("is not something a stray body can ask for", async () => {
    const { me, round: first } = await finished();

    for (const restart of [1, "true", "yes", {}, null]) {
      const { body } = await me.start({ restart });
      assert.equal(body.round.id, first.id, `${JSON.stringify(restart)} is not a yes`);
    }
  });

  it("keeps the round still under way rather than starting over it", async () => {
    const me = visitor(baseUrl, pool);
    await me.start();
    await me.find(CHARACTERS[0]!);

    // Two presses of "play again", or a stale one behind the dialog: a round
    // the player is still playing is not theirs to throw away by accident.
    const { res, body } = await me.playAgain();

    assert.equal(res.status, 200);
    assert.equal(
      body.characters.find((c) => c.name === CHARACTERS[0])?.found,
      true,
      "the finds they had are still theirs",
    );
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM rounds");
    assert.equal(rows[0]!.n, 1, "and there is still only one round");
  });
});