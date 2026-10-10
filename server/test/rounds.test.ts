import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type pg from "pg";

import { createApp } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/session.ts";
import { databaseUrl } from "../src/db.ts";
import { freshTestPool, resetRoundData } from "./helpers/database.ts";

process.env.SESSION_SECRET ??= "test-secret-not-used-in-production";
process.env.NODE_ENV = "test";

type StartResponse = {
  round: { id: string; startedAt: string; finishedAt: string | null; elapsedMs: number | null };
  characters: { name: string; found: boolean }[];
};

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

/** A session that keeps its cookie between calls, the way a browser would. */
function session() {
  let cookie = "";
  return async () => {
    const res = await fetch(`${baseUrl}/api/rounds`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    return { res, body: (await res.json()) as StartResponse, cookie };
  };
}

describe("POST /api/rounds", () => {
  it("gives a first-time visitor a round, the six characters, and a session cookie", async () => {
    const visit = session();
    const { res, body } = await visit();

    assert.equal(res.status, 200);
    assert.equal(body.characters.length, 6);
    assert.equal(
      body.characters.every((c) => c.found === false),
      true,
      "a round starts with nothing found",
    );
    assert.ok(body.round.startedAt, "the round carries a start time");
    assert.equal(body.round.finishedAt, null);
    assert.equal(body.round.elapsedMs, null);
  });

  it("names each character as something a player can search for", async () => {
    const { body } = await session()();

    assert.deepEqual(
      body.characters.map((c) => c.name),
      [
        "Wanda, the pink dancer",
        "Spike, the shark",
        "Diablo, the red devil",
        "Lemkin, the yellow creature",
        "Vince, the detective",
        "Boris, the blue hologram",
      ],
    );
  });

  it("never tells the browser where a character is", async () => {
    const { body } = await session()();

    for (const c of body.characters) {
      assert.deepEqual(
        Object.keys(c).sort(),
        ["found", "name"],
        `${c.name} is a name and a found flag, nothing else`,
      );
    }
    assert.doesNotMatch(JSON.stringify(body), /"x"|"y"|"w"|"h"/);
  });

  it("resumes the same round on a refresh, start time included", async () => {
    const visit = session();
    const first = await visit();
    const second = await visit();

    assert.equal(second.body.round.id, first.body.round.id);
    assert.equal(
      second.body.round.startedAt,
      first.body.round.startedAt,
      "a refresh cannot restart the clock",
    );
  });

  it("hands a returning visitor the cookie back unchanged", async () => {
    const visit = session();
    await visit();
    const { res } = await visit();

    assert.equal(
      res.headers.get("set-cookie"),
      null,
      "a valid cookie is not rewritten",
    );
  });

  it("keeps the session cookie out of reach of scripts and other sites", async () => {
    const res = await fetch(`${baseUrl}/api/rounds`, { method: "POST" });
    const cookie = res.headers.get("set-cookie")!;

    assert.match(cookie, /^ww_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Max-Age=2592000/i, "30 days");
    assert.doesNotMatch(cookie, /Secure/i, "not secure outside production");
  });

  it("marks the cookie secure once it is running in production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await fetch(`${baseUrl}/api/rounds`, { method: "POST" });
      assert.match(res.headers.get("set-cookie")!, /Secure/i);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("gives two visitors two separate rounds", async () => {
    const a = await session()();
    const b = await session()();

    assert.notEqual(a.body.round.id, b.body.round.id);
  });

  it("refuses a forged cookie instead of adopting the session it names", async () => {
    const { body: honest } = await session()();
    const res = await fetch(`${baseUrl}/api/rounds`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=s:9f1c2b3a-4d5e-4f6a-8b9c-0d1e2f3a4b5c.badsignature` },
    });
    const body = (await res.json()) as StartResponse;

    assert.notEqual(body.round.id, honest.round.id);
  });

  it("ignores a duration the client tries to report, per ADR-0001", async () => {
    const before = new Date().toISOString();
    const res = await fetch(`${baseUrl}/api/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elapsedMs: 1, startedAt: "1999-01-01T00:00:00.000Z" }),
    });
    const body = (await res.json()) as StartResponse;

    assert.equal(body.round.elapsedMs, null, "the client cannot set a score");
    assert.equal(body.round.finishedAt, null);
    const started = new Date(body.round.startedAt).toISOString();
    assert.ok(started >= before, `started_at ${started} was not taken from the request`);
  });

  it("starts the round from the database's own clock, never a client's", async () => {
    const before = new Date().toISOString();
    const { body } = await session()();
    const after = new Date().toISOString();

    const started = new Date(body.round.startedAt).toISOString();
    assert.ok(
      started >= before && started <= after,
      `started_at ${started} should sit between the request's own bounds`,
    );
  });
});
