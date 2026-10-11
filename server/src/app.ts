import cookieParser from "cookie-parser";
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

import { parseGuess } from "./guess.ts";
import { claimedSession, sessionSecret, startSession } from "./session.ts";
import { parseTag, TAG_MAX } from "./tag.ts";
import { isInside, type TargetBox } from "./target-box.ts";

type RoundRow = {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  elapsed_ms: number | null;
};

type CharacterRow = {
  name: string;
  found: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

type LeaderboardRow = {
  session_id: string;
  tag: string | null;
  elapsed_ms: number;
  finished_at: Date;
};

type YourRow = { elapsed_ms: number };

/** Every Character, with whether this round has found it, and its Target box.
 *
 *  The box is sent so the browser can crop a portrait out of the picture the
 *  player is already looking at, rather than carrying a second set of artwork
 *  that could drift from the first. That makes the boxes readable in devtools,
 *  and the browser could already have read them off the picture anyway: there is
 *  nothing here the player does not already have. Round is nullable — with no
 *  round there is no find, so every character comes back unfound.
 */
async function characters(
  pool: pg.Pool,
  roundId: string | null,
): Promise<CharacterRow[]> {
  const { rows } = await pool.query<CharacterRow>(
    `SELECT t.name, (f.target_id IS NOT NULL) AS found, t.x, t.y, t.w, t.h
       FROM targets t
       LEFT JOIN finds f ON f.target_id = t.id AND f.round_id = $1
      ORDER BY t.id`,
    [roundId],
  );
  return rows;
}

/** A round as the browser is told about it, in the shape it stores. */
const asRound = (round: RoundRow) => ({
  id: round.id,
  startedAt: round.started_at.toISOString(),
  finishedAt: round.finished_at?.toISOString() ?? null,
  elapsedMs: round.elapsed_ms,
});

/**
 * A brand new round for this session, whatever state the last one is in.
 *
 * Nothing here is conditional, because a finished round cannot block the next
 * one: the partial unique index only covers rounds still under way. A round
 * still under way does block it, and being handed that round instead is the
 * right answer — a player who pressed "play again" twice has lost the first
 * press to the second, not asked to throw away a round they are still playing.
 */
const NEW_ROUND = `INSERT INTO rounds (session_id) VALUES ($1)
  ON CONFLICT (session_id) WHERE finished_at IS NULL
  DO UPDATE SET session_id = EXCLUDED.session_id
  RETURNING id, started_at, finished_at, elapsed_ms`;

/**
 * The round this session is playing: the most recent one it has, or a new one
 * if it has never played. A finished round is still the session's round — the
 * player came back to be shown their score, and handing them a fresh clock
 * instead would throw it away — so only a round that has never existed is
 * created here.
 *
 * One statement, because the two branches read the same snapshot and so cannot
 * both answer: with a round already there `fresh` produces nothing and the
 * session's own round comes back; with none, `fresh` inserts it. Two requests
 * arriving together for a session that has never played cannot both insert one,
 * because the second waits on the partial index and is handed the round the
 * first inserted.
 */
const RESUME_OR_NEW = `WITH newest AS (
    SELECT id, started_at, finished_at, elapsed_ms
      FROM rounds WHERE session_id = $1
     ORDER BY started_at DESC LIMIT 1
  ), fresh AS (
    INSERT INTO rounds (session_id)
    SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM newest)
    ON CONFLICT (session_id) WHERE finished_at IS NULL
    DO UPDATE SET session_id = EXCLUDED.session_id
    RETURNING id, started_at, finished_at, elapsed_ms
  )
  SELECT * FROM fresh
  UNION ALL
  SELECT * FROM newest
  LIMIT 1`;

/**
 * The ten fastest finished rounds, one row per session on its best score.
 *
 * DISTINCT ON picks the best round of each session — a player who plays twenty
 * times is one entry on a board, not twenty — and the outer ORDER BY puts those
 * sessions in score order afterwards. Only rounds with both a finish and a
 * score are ranked, so an abandoned round never appears. A session is named by
 * its own opaque id and, if it chose one, the tag the player typed: the table
 * holds no address and nothing about who anyone is, and a Tag is a name and
 * nothing more (GLOSSARY.md). The tag is read here, at the one moment it is
 * shown, rather than copied onto the round when it was scored — it belongs to
 * the Session, so retagging a session retags every score it ever set (ADR-0004).
 */
const LEADERBOARD = `SELECT session_id, tag, elapsed_ms, finished_at FROM (
    SELECT DISTINCT ON (r.session_id) r.session_id, s.tag, r.elapsed_ms, r.finished_at
      FROM rounds r
      JOIN sessions s ON s.id = r.session_id
     WHERE r.finished_at IS NOT NULL AND r.elapsed_ms IS NOT NULL
     ORDER BY r.session_id, r.elapsed_ms, r.finished_at
  ) AS best
  ORDER BY elapsed_ms, finished_at
  LIMIT 10`;

/** The one score this session would be judged by, ranked or not — the same
 *  best-of rule the board uses, so the two can never disagree. */
const YOUR_SCORE = `SELECT elapsed_ms
  FROM rounds
 WHERE session_id = $1 AND finished_at IS NOT NULL AND elapsed_ms IS NOT NULL
 ORDER BY elapsed_ms, finished_at
 LIMIT 1`;

/**
 * Finish the round if the last character has just been found, and return it.
 *
 * The score is the database's own arithmetic on its own clock: `now()` minus
 * the round's start, in the same statement that records the end, so the two can
 * never be measurements of different moments (ADR-0001). The condition is
 * checked here rather than counted in the request handler, because the row this
 * UPDATE locks is the round itself: two guesses racing to be the last are
 * settled by the database, and only the one that finds an unfinished round
 * records a score.
 */
const FINISH_IF_COMPLETE = `UPDATE rounds
   SET finished_at = now(),
       elapsed_ms  = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
 WHERE id = $1
   AND finished_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM targets t
      WHERE NOT EXISTS (
        SELECT 1 FROM finds f WHERE f.round_id = $1 AND f.target_id = t.id
      )
   )
 RETURNING id, started_at, finished_at, elapsed_ms`;

/** The round this session is playing, if it has one. Reads and never writes: the
 *  question "is there a round yet?" is what decides whether the player is met
 *  with the briefing, and asking it must not answer it by starting one. */
const CURRENT_ROUND = `SELECT id, started_at, finished_at, elapsed_ms
  FROM rounds WHERE session_id = $1
 ORDER BY started_at DESC LIMIT 1`;

/** The Tag a Session plays under, or null if it has never chosen one.
 *
 * The Tag belongs to the Session and not to a Round (ADR-0004): the board keeps
 * a Session's best score and throws the rest away, so the tag shown beside that
 * score has to be the Session's own, not one Round's. */
async function currentTag(pool: pg.Pool, sessionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ tag: string | null }>(
    "SELECT tag FROM sessions WHERE id = $1",
    [sessionId],
  );
  return rows[0]?.tag ?? null;
}

/**
 * Write a Tag onto a Session and hand back what is now stored.
 *
 * One place, because a Session's tag is written from two requests — the one
 * that starts a round and the one that retags a player — and they must not be
 * able to drift apart. Returning the stored tag rather than the one asked for
 * means no caller has to guess what the database made of it.
 */
async function storeTag(
  pool: pg.Pool,
  sessionId: string,
  tag: string,
): Promise<string | null> {
  const { rows, rowCount } = await pool.query<{ tag: string | null }>(
    "UPDATE sessions SET tag = $2 WHERE id = $1 RETURNING tag",
    [sessionId, tag],
  );
  return rowCount === 0 ? null : rows[0]!.tag;
}

/** The one thing a Tag must not be, said once so both requests say it alike. */
const BAD_TAG = `A tag is between 1 and ${TAG_MAX} characters.`;

/**
 * The built client, served from the same process as the API.
 *
 * One process on one port, so there is no second host, no CORS and no cookie
 * that has to cross an origin to work. The client is addressed with paths the
 * browser has never seen before ("/score", a refresh mid-round), so anything the
 * API has not claimed falls through to the page, which reads the route itself.
 */
const CLIENT_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "client",
  "dist",
);

/**
 * A year, for the files whose names carry a hash of their own contents. The name
 * changes whenever the bytes do, so a cached copy can never be stale — which is
 * exactly the promise Express's default (no caching at all) refuses to make.
 */
const FINGERPRINTED = { maxAge: "1y", immutable: true };

export function createApp(pool: pg.Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(sessionSecret()));

  /** Whether the database answers, for the platform's health check. A plain GET,
   *  because that is what a health check is: it must not need a session, and a
   *  green light on an unreachable database is worse than a red one. */
  app.get("/api/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // A GET, and so readable by anyone with no session at all: arriving at the
  // page is not a decision to play, so it neither starts a session nor a round.
  // A null round means the briefing is what this player is owed; the characters
  // come back regardless, because the briefing is where they are read.
  app.get("/api/rounds/current", async (req, res) => {
    const sessionId = claimedSession(req);
    const { rows } = sessionId
      ? await pool.query<RoundRow>(CURRENT_ROUND, [sessionId])
      : { rows: [] };
    const round = rows[0];

    res.json({
      round: round ? asRound(round) : null,
      characters: await characters(pool, round?.id ?? null),
      tag: sessionId ? await currentTag(pool, sessionId) : null,
    });
  });

  // Renaming is not starting anything: the round under way keeps its clock and
  // its score, and only the Tag beside it changes. Refused without a Session,
  // because there is nobody to rename.
  app.patch("/api/session", async (req, res) => {
    const sessionId = claimedSession(req);
    if (!sessionId) {
      res.status(401).json({ error: "No session to rename." });
      return;
    }
    const tag = parseTag((req.body as { tag?: unknown } | undefined)?.tag);
    if (!tag) {
      res.status(400).json({ error: BAD_TAG });
      return;
    }

    const stored = await storeTag(pool, sessionId, tag);
    if (stored === null) {
      res.status(401).json({ error: "No session to rename." });
      return;
    }

    res.json({ tag: stored });
  });

  app.post("/api/rounds", async (req, res) => {
    const body = (req.body as
      | { restart?: unknown; tag?: unknown }
      | undefined) ?? {};

    // A tag sent and a tag refused are different things, so they are told apart
    // before anything is written: a round is not started for a tag the server
    // will not store, rather than started and then half-applied.
    const sentTag = "tag" in body ? parseTag(body.tag) : null;
    if ("tag" in body && sentTag === null) {
      res.status(400).json({ error: BAD_TAG });
      return;
    }

    const sessionId = claimedSession(req) ?? startSession(res);

    await pool.query(
      "INSERT INTO sessions (id) VALUES ($1) ON CONFLICT DO NOTHING",
      [sessionId],
    );
    const tag =
      sentTag === null
        ? await currentTag(pool, sessionId)
        : await storeTag(pool, sessionId, sentTag);

    // The same request resumes a round and starts the next one. What tells them
    // apart is the player's intent, not the shape of the round: asking for a
    // round wants the one already under way, and pressing "play again" wants a
    // new one. Anything but an exact `true` is not a request to start one.
    const again = body.restart === true;
    const { rows } = await pool.query<RoundRow>(
      again ? NEW_ROUND : RESUME_OR_NEW,
      [sessionId],
    );
    const round = rows[0]!;

    // A round whose last character has been found is over, even if the request
    // that found it never got to say so: recording the find and finishing the
    // round are two statements, and a connection that dies between them would
    // otherwise leave a round that can never be finished — there is nothing
    // left to guess at. Settling it here costs one UPDATE that is a no-op for
    // every round that is not complete.
    const { rows: settled } = round.finished_at
      ? { rows: [] }
      : await pool.query<RoundRow>(FINISH_IF_COMPLETE, [round.id]);
    const finishedRound = settled[0] ?? round;

    res.json({
      round: asRound(finishedRound),
      characters: await characters(pool, finishedRound.id),
      tag,
    });
  });

  app.post("/api/guesses", async (req, res) => {
    const guess = parseGuess(req.body);
    if (!guess) {
      res.status(400).json({ error: "A guess is one character and one point on the picture." });
      return;
    }

    const sessionId = claimedSession(req);
    // The round being guessed at is the live one; a session with none left has
    // finished every round it has, and the earliest of those answers "over".
    const { rows: rounds } = sessionId
      ? await pool.query<RoundRow>(
          "SELECT * FROM rounds WHERE session_id = $1 ORDER BY finished_at NULLS FIRST LIMIT 1",
          [sessionId],
        )
      : { rows: [] };
    const round = rounds[0];
    if (!round) {
      res.status(404).json({ error: "No round to guess at. Start one first." });
      return;
    }
    if (round.finished_at) {
      res.status(409).json({ error: "This round is already over." });
      return;
    }

    const { rows: targets } = await pool.query<TargetBox & { id: number }>(
      "SELECT id, x, y, w, h FROM targets WHERE name = $1",
      [guess.name],
    );
    const target = targets[0];
    if (!target) {
      res.status(400).json({ error: "No character by that name." });
      return;
    }

    const { rowCount: findsBefore } = await pool.query(
      "SELECT 1 FROM finds WHERE round_id = $1 AND target_id = $2",
      [round.id, target.id],
    );

    // A hit is a point in the box and nothing else, whether or not the
    // character was found earlier: the answer must never claim a point held
    // a character it does not. A repeat hit records nothing new, and the
    // primary key keeps two guesses racing each other to one find.
    const hit = isInside(guess.x, guess.y, target);
    if (hit && findsBefore === 0) {
      await pool.query(
        "INSERT INTO finds (round_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [round.id, target.id],
      );
    }

    // Every answer reports the whole state, hit or miss alike, so the client
    // never has to work out what a miss did or a hit did not. It carries the
    // round too: the round that finishes is finished by this very answer, and
    // the score the player is shown is the one written here (ADR-0001).
    const { rows: finished } = await pool.query<RoundRow>(FINISH_IF_COMPLETE, [
      round.id,
    ]);

    res.json({
      hit,
      characters: await characters(pool, round.id),
      round: asRound(finished[0] ?? round),
    });
  });

  // A GET, and so readable by anyone with no session at all: the board is the
  // public record of every score, and asking for it never invents a session.
  app.get("/api/leaderboard", async (req, res) => {
    const sessionId = claimedSession(req);
    const { rows } = await pool.query<LeaderboardRow>(LEADERBOARD);
    const mine = sessionId
      ? await pool.query<YourRow>(YOUR_SCORE, [sessionId])
      : { rows: [] };

    const yours = mine.rows[0];
    res.json({
      entries: rows.map((row) => ({
        session: row.session_id,
        tag: row.tag,
        elapsedMs: row.elapsed_ms,
        finishedAt: row.finished_at.toISOString(),
        you: row.session_id === sessionId,
      })),
      yours: yours ? { elapsedMs: yours.elapsed_ms } : null,
    });
  });

  // An address under /api that no route claimed is a mistake worth naming, not
  // a page: answering it with the HTML shell would turn a typo in a fetch into a
  // silent parse failure in the browser.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "No such thing here." });
  });

  // Vite writes the hashed JS and CSS into assets/ and copies everything else —
  // the picture, the font, the favicon — to the root of dist. Those copies keep
  // their own names, so they are cached briefly rather than forever: a deploy
  // that changes the picture should be picked up without anyone clearing a cache.
  //
  // `index: false` on the second one, because index.html is the file that names
  // the current hashed assets: served from here for GET /, it would carry an
  // hour's cache and a deploy would 404 every player on the new bundles. The
  // fallback below sends it uncached instead, and this leaves it to that.
  app.use("/assets", express.static(join(CLIENT_DIST, "assets"), FINGERPRINTED));
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: "1h" }));

  if (!existsSync(join(CLIENT_DIST, "index.html"))) {
    console.warn(`No client build at ${CLIENT_DIST}; serving the API only.`);
  }

  // Everything else is the game itself. The client is one page with no router of
  // its own, so there is nothing to route on — but a refresh mid-round, a
  // bookmark, or a stray path must still land on the page that can ask the
  // server what happened, rather than on Express's "Cannot POST /x" page.
  //
  // Every method, not just GET: a HEAD or POST to an unknown address is still an
  // address the game owns, and answering it with an error page is the one thing
  // this exists to prevent.
  app.use((_req, res, next) => {
    res.setHeader("cache-control", "no-cache");
    res.sendFile(join(CLIENT_DIST, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  // Express 5 forwards a rejected handler here, so a database that has gone
  // away answers the player in words rather than in a hung request.
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    },
  );

  return app;
}
