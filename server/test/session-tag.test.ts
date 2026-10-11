import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type pg from "pg";

import { createApp } from "../src/app.ts";
import { databaseUrl } from "../src/db.ts";
import { freshTestPool, resetRoundData } from "./helpers/database.ts";
import { visitor, type StartResponse } from "./helpers/visitor.ts";

process.env.SESSION_SECRET ??= "test-secret-not-used-in-production";
process.env.NODE_ENV = "test";

/** What a tag endpoint answers with: the stored tag, or why it would not. */
type TagResponse = StartResponse & { tag?: string | null; error?: string };

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

/** The tag a session is actually carrying, read past the API on purpose. */
async function storedTag(sessionId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT tag FROM sessions WHERE id = $1", [
    sessionId,
  ]);
  return rows[0]!.tag;
}

/** A visitor who keeps their cookie, plus a way to name their own session id. */
function player() {
  const v = visitor(baseUrl, pool);
  let cookie = "";
  const send = async (path: string, method: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    return { res, body: (await res.json()) as TagResponse };
  };
  return {
    send,
    async start(tag?: string) {
      return send("/api/rounds", "POST", tag === undefined ? {} : { tag });
    },
    again: () => send("/api/rounds", "POST", { restart: true }),
    cookie: () => cookie,
  };
}

/** The session id the cookie is signed for, without going through the server. */
function sessionIdOf(cookie: string): string {
  return decodeURIComponent(cookie.split(".")[0]!.split("=")[1]!).replace(/^s:/, "");
}

describe("the tag a session plays under", () => {
  it("keeps the tag the player arrived with", async () => {
    const p = player();

    const { res, body } = await p.start("Ada");

    assert.equal(res.status, 200);
    assert.equal(body.tag, "Ada");
  });

  it("stores it against the session, so the next round and the board agree", async () => {
    const p = player();
    await p.start("Ada");

    assert.equal(await storedTag(sessionIdOf(p.cookie())), "Ada");
  });

  it("plays happily under no tag at all", async () => {
    const p = player();

    const { res, body } = await p.start();

    assert.equal(res.status, 200, "a tag is optional");
    assert.equal(body.tag, null);
  });

  it("trims what the keyboard left behind", async () => {
    const p = player();

    const { body } = await p.start("  Ada \n");

    assert.equal(body.tag, "Ada");
  });

  it("refuses a tag it cannot store, and starts no round for it", async () => {
    const p = player();

    const { res, body } = await p.start("a".repeat(17));

    assert.equal(res.status, 400);
    assert.match(body.error!, /tag/i);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM rounds");
    assert.equal(rows[0]!.n, 0, "a refused tag must not half-start a round");
  });

  it("refuses a tag of nothing but spaces", async () => {
    const p = player();

    const { res } = await p.start("   ");

    assert.equal(res.status, 400);
  });

  it("leaves the tag alone when a later round says nothing about it", async () => {
    const p = player();
    await p.start("Ada");

    const { res, body } = await p.again();

    assert.equal(res.status, 200);
    assert.equal(body.tag, "Ada", "playing again is not renouncing your name");
  });

  it("takes a new tag on a later round when the player gives one", async () => {
    const p = player();
    await p.start("Ada");

    const { body } = await p.start("Grace");

    assert.equal(body.tag, "Grace");
    assert.equal(await storedTag(sessionIdOf(p.cookie())), "Grace");
  });
});

describe("PATCH /api/session", () => {
  it("renames a session mid-round, without touching the round", async () => {
    const p = player();
    const { body: started } = await p.start("Ada");

    const { res, body } = await p.send("/api/session", "PATCH", { tag: "Grace" });

    assert.equal(res.status, 200);
    assert.equal(body.tag, "Grace");
    assert.equal(await storedTag(sessionIdOf(p.cookie())), "Grace");
  });

  it("refuses a tag it cannot store, leaving the old one in place", async () => {
    const p = player();
    await p.start("Ada");

    const { res } = await p.send("/api/session", "PATCH", { tag: "   " });

    assert.equal(res.status, 400);
    assert.equal(await storedTag(sessionIdOf(p.cookie())), "Ada");
  });

  it("refuses a forged cookie rather than renaming somebody else's session", async () => {
    const p = player();
    await p.start("Ada");

    const res = await fetch(`${baseUrl}/api/session`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: "ww_session=s:9f1c2b3a-4d5e-4f6a-8b9c-0d1e2f3a4b5c.badsignature",
      },
      body: JSON.stringify({ tag: "Grace" }),
    });

    assert.equal(res.status, 401);
    assert.equal(await storedTag(sessionIdOf(p.cookie())), "Ada");
  });

  it("is refused outright to a visitor who has no session yet", async () => {
    const res = await fetch(`${baseUrl}/api/session`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "Grace" }),
    });

    assert.equal(res.status, 401);
  });
});