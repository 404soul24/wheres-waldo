import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import pg from "pg";

import { createApp } from "../src/app.ts";
import { databaseUrl } from "../src/db.ts";
import { freshTestPool } from "./helpers/database.ts";

process.env.SESSION_SECRET ??= "test-secret-not-used-in-production";
process.env.NODE_ENV = "test";

const CLIENT_DIST = new URL("../../client/dist/", import.meta.url);

type App = ReturnType<typeof createApp>;
type Listening = ReturnType<App["listen"]>;

let pool: pg.Pool;
let baseUrl: string;
let server: Listening;

/** Servers started by these tests and not by `before`, so a failed check does
 *  not leave one listening and hang the whole file. */
const startedHere: Listening[] = [];

/** A second app on its own port, for a check that needs its own environment. */
async function listeningOn(app: App): Promise<string> {
  const s = app.listen(0);
  startedHere.push(s);
  await new Promise((resolve) => s.once("listening", resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

before(async () => {
  pool = await freshTestPool(databaseUrl());
  baseUrl = await listeningOn(createApp(pool));
});

after(async () => {
  await Promise.all(
    startedHere.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
  await pool?.end();
});

const get = (path: string) => fetch(`${baseUrl}${path}`);

describe("the built client, served by the server", () => {
  it("answers the root with the game itself", async () => {
    const res = await get("/");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /<div id="root">/);
  });

  it("sends the root uncached, because it names the hashed assets", async () => {
    const res = await get("/");

    assert.equal(
      res.headers.get("cache-control"),
      "no-cache",
      "a cached index.html points a browser at bundles the last deploy deleted",
    );
  });

  it("serves a fingerprinted asset with a long-lived cache", async () => {
    const assets = readdirSync(new URL("assets/", CLIENT_DIST));
    const file = assets.find((name) => name.endsWith(".js"))!;

    const res = await get(`/assets/${file}`);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.match(
      res.headers.get("cache-control") ?? "",
      /max-age=31536000/,
      "a name that changes when the bytes do can be cached forever",
    );
  });

  it("answers a deep link with the game, not an error", async () => {
    const res = await get("/some/route/the/client/made/up");

    assert.equal(res.status, 200);
    assert.match(await res.text(), /<div id="root">/);
  });

  it("answers a deep link however it is asked for", async () => {
    // A refresh, a prefetch and a link checker all reach the game by a method
    // that is not GET. Express's own "Cannot POST /x" page is a server error
    // wearing a costume, which is exactly what the fallback exists to prevent.
    for (const method of ["HEAD", "POST"]) {
      const res = await fetch(`${baseUrl}/some/route/the/client/made/up`, {
        method,
      });

      assert.equal(res.status, 200, `${method} to an unknown address`);
    }
  });

  it("still says so when an address is not an address", async () => {
    const res = await get("/api/nothing-here");

    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });
});

describe("the health endpoint", () => {
  it("reports a reachable database", async () => {
    const res = await get("/api/health");

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("reports a database it cannot reach, rather than a healthy lie", async () => {
    const dead = new pg.Pool({
      connectionString: "postgres://nobody:nobody@127.0.0.1:1/nothing",
      connectionTimeoutMillis: 1000,
    });
    const another = await listeningOn(createApp(dead));

    try {
      const res = await fetch(`${another}/api/health`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false });
    } finally {
      await dead.end();
    }
  });
});

describe("the session cookie over HTTPS", () => {
  it("is marked secure in production", async () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const another = await listeningOn(createApp(pool));

    try {
      const res = await fetch(`${another}/api/rounds`, { method: "POST" });

      assert.match(res.headers.get("set-cookie") ?? "", /Secure/);
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});