import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type pg from "pg";

import { createApp } from "../src/app.ts";
import { databaseUrl } from "../src/db.ts";
import { freshTestPool, resetRoundData } from "./helpers/database.ts";

process.env.SESSION_SECRET ??= "test-secret-not-used-in-production";
process.env.NODE_ENV = "test";

type StartResponse = {
  round: { id: string };
  characters: { name: string; found: boolean }[];
};

type GuessResponse = {
  hit: boolean;
  characters: { name: string; found: boolean }[];
};

const WANDA = "Wanda, the pink dancer";
const SPIKE = "Spike, the shark";
const LEMKIN = "Lemkin, the yellow creature";

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

/** A visitor with a round already under way, and their cookie in hand. */
async function started() {
  let cookie = "";
  const res = await fetch(`${baseUrl}/api/rounds`, { method: "POST" });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  await res.json();

  const guess = async (body: unknown) => {
    const reply = await fetch(`${baseUrl}/api/guesses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { res: reply, body: (await reply.json()) as GuessResponse };
  };
  return guess;
}

/** A point at the middle of a seeded character's target box. */
const centreOf = async (name: string) => {
  const { rows } = await pool.query(
    "SELECT (x + w / 2) AS x, (y + h / 2) AS y FROM targets WHERE name = $1",
    [name],
  );
  return rows[0] as { x: number; y: number };
};

describe("POST /api/guesses", () => {
  it("calls a point inside the character's own box a hit", async () => {
    const guess = await started();
    const { x, y } = await centreOf(WANDA);

    const { res, body } = await guess({ name: WANDA, x, y });

    assert.equal(res.status, 200);
    assert.equal(body.hit, true);
    assert.equal(body.characters.find((c) => c.name === WANDA)?.found, true);
  });

  it("calls a point outside every box a miss, and costs nothing", async () => {
    const guess = await started();

    const { res, body } = await guess({ name: WANDA, x: 0.5, y: 0.5 });

    assert.equal(res.status, 200, "a miss is an ordinary answer");
    assert.equal(body.hit, false);
    assert.equal(
      body.characters.some((c) => c.found),
      false,
      "a miss leaves no record",
    );
  });

  it("calls a point inside another character's box a miss for the one named", async () => {
    const guess = await started();
    const { x, y } = await centreOf(SPIKE);

    const { body } = await guess({ name: WANDA, x, y });

    assert.equal(body.hit, false, "Spike's box is not Wanda's box");
    assert.equal(body.characters.some((c) => c.found), false);
  });

  it("treats a repeated guess for a found character as a no-op, not an error", async () => {
    const guess = await started();
    const { x, y } = await centreOf(WANDA);
    await guess({ name: WANDA, x, y });

    const { res, body } = await guess({ name: WANDA, x, y });

    assert.equal(res.status, 200);
    assert.equal(body.hit, true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM finds");
    assert.equal(rows[0]!.n, 1, "the find is recorded once");
  });

  it("calls a repeat guess at a point outside the box a miss, not a hit", async () => {
    const guess = await started();
    const { x, y } = await centreOf(WANDA);
    await guess({ name: WANDA, x, y });

    const { res, body } = await guess({ name: WANDA, x: 0.5, y: 0.5 });

    assert.equal(res.status, 200);
    assert.equal(body.hit, false, "a found character is not everywhere");
    assert.equal(body.characters.find((c) => c.name === WANDA)?.found, true, "and stays found");
  });

  it("answers with every character currently found, so the client need not guess", async () => {
    const guess = await started();
    const spike = await centreOf(SPIKE);
    await guess({ name: SPIKE, x: spike.x, y: spike.y });
    const lemkin = await centreOf(LEMKIN);
    await guess({ name: LEMKIN, x: lemkin.x, y: lemkin.y });

    const { body } = await guess({ name: WANDA, x: 0.5, y: 0.5 });

    const found = body.characters.filter((c) => c.found).map((c) => c.name);
    assert.deepEqual(found, [SPIKE, LEMKIN]);
  });

  it("never echoes a target box back to the browser", async () => {
    const guess = await started();
    const { x, y } = await centreOf(WANDA);

    const { body } = await guess({ name: WANDA, x, y });

    assert.doesNotMatch(JSON.stringify(body), /"x"|"y"|"w"|"h"/);
  });

  it("refuses a point outside 0-1 rather than clamping it", async () => {
    const guess = await started();

    for (const point of [
      { x: -0.1, y: 0.5 },
      { x: 1.1, y: 0.5 },
      { x: 0.5, y: -0.2 },
      { x: 0.5, y: 2 },
    ]) {
      const { res, body } = await guess({ name: WANDA, ...point });
      assert.equal(res.status, 400, `${JSON.stringify(point)} is not a fraction`);
      assert.equal(body.hit, undefined);
    }

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM finds");
    assert.equal(rows[0]!.n, 0, "a refused guess records nothing");
  });

  it("refuses a guess that is not a character and a point", async () => {
    const guess = await started();

    for (const body of [
      { name: WANDA, x: "0.5", y: 0.5 },
      { name: WANDA, x: 0.5 },
      { name: 42, x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      {},
    ]) {
      const { res } = await guess(body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} is not a guess`);
    }
  });

  it("ignores a duration the client tries to report, per ADR-0001", async () => {
    const guess = await started();
    const { x, y } = await centreOf(WANDA);

    const { res, body } = await guess({
      name: WANDA,
      x,
      y,
      elapsedMs: 1,
      finishedAt: "1999-01-01T00:00:00.000Z",
    });

    assert.equal(res.status, 200);
    assert.equal(body.hit, true);
    const { rows } = await pool.query("SELECT finished_at, elapsed_ms FROM rounds");
    assert.equal(rows[0]!.finished_at, null, "the client cannot end the round");
    assert.equal(rows[0]!.elapsed_ms, null, "the client cannot set a score");
  });

  it("refuses guesses once the round is finished", async () => {
    const guess = await started();
    await pool.query("UPDATE rounds SET finished_at = now(), elapsed_ms = 1234");
    const { x, y } = await centreOf(WANDA);

    const { res } = await guess({ name: WANDA, x, y });

    assert.equal(res.status, 409);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM finds");
    assert.equal(rows[0]!.n, 0);
  });

  it("keeps one player's finds out of another's round", async () => {
    const mine = await started();
    const { x, y } = await centreOf(WANDA);
    await mine({ name: WANDA, x, y });

    const res = await fetch(`${baseUrl}/api/rounds`, { method: "POST" });
    const theirs = (await res.json()) as StartResponse;

    assert.notEqual(theirs.round.id, "");
    assert.equal(
      theirs.characters.some((c) => c.found),
      false,
      "a new visitor inherits nobody's finds",
    );
  });

  it("asks for a round when the guess arrives before one exists", async () => {
    const res = await fetch(`${baseUrl}/api/guesses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: WANDA, x: 0.5, y: 0.5 }),
    });

    assert.equal(res.status, 404);
  });
});