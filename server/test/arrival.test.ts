import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type pg from "pg";

import { createApp } from "../src/app.ts";
import { databaseUrl } from "../src/db.ts";
import { SESSION_COOKIE } from "../src/session.ts";
import { freshTestPool, resetRoundData } from "./helpers/database.ts";
import { visitor, type Character, type Round } from "./helpers/visitor.ts";

process.env.SESSION_SECRET ??= "test-secret-not-used-in-production";
process.env.NODE_ENV = "test";

type ArrivalResponse = {
  round: Round | null;
  characters: Character[];
  tag: string | null;
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

/** What the page asks the server when it loads, before anything is started. */
async function arrive(cookie?: string) {
  const res = await fetch(`${baseUrl}/api/rounds/current`, {
    headers: cookie ? { cookie } : {},
  });
  assert.equal(res.status, 200);
  return { res, body: (await res.json()) as ArrivalResponse };
}

describe("GET /api/rounds/current", () => {
  it("gives a first-time visitor no round at all, so the briefing can come first", async () => {
    const { body } = await arrive();

    assert.equal(body.round, null, "a round is only created when the player says go");
  });

  it("starts no clock behind the briefing", async () => {
    await arrive();

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM rounds");
    assert.equal(rows[0]!.n, 0, "reading the briefing must not cost the player seconds");
  });

  it("still lists the characters to find, so the briefing has something to show", async () => {
    const { body } = await arrive();

    assert.equal(body.characters.length, 6);
  });

  it("hands back the round already under way, start time and all", async () => {
    const v = visitor(baseUrl, pool);
    const first = await v.start();

    const { body } = await arrive(first.res.headers.get("set-cookie")?.split(";")[0]!);

    assert.equal(body.round?.id, first.body.round.id);
    assert.equal(
      body.round?.startedAt,
      first.body.round.startedAt,
      "a refresh cannot restart the clock",
    );
  });

  it("reports the characters a returning visitor has already found", async () => {
    const v = visitor(baseUrl, pool);
    const { res } = await v.start();
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    await v.find("Wanda, the pink dancer");

    const { body } = await arrive(cookie);

    assert.equal(body.characters.find((c) => c.name === "Wanda, the pink dancer")?.found, true);
  });

  it("asks for no session, the way reading the leaderboard asks for none", async () => {
    const res = await fetch(`${baseUrl}/api/rounds/current`);

    assert.equal(
      res.headers.get("set-cookie"),
      null,
      "a page load is not a session until the player does something",
    );
  });

  it("refuses a forged cookie rather than adopting the session it names", async () => {
    const v = visitor(baseUrl, pool);
    const { body: honest } = await v.start();

    const { body } = await arrive(
      `${SESSION_COOKIE}=s:9f1c2b3a-4d5e-4f6a-8b9c-0d1e2f3a4b5c.badsignature`,
    );

    assert.notEqual(body.round?.id, honest.round.id);
  });
});