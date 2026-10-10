import cookieParser from "cookie-parser";
import express from "express";
import type pg from "pg";

import { parseGuess } from "./guess.ts";
import { claimedSession, sessionSecret, startSession } from "./session.ts";
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
};

/** Every Character, with whether this round has found it. Where none are is
 * never sent: the target boxes stay on the server. */
async function characters(
  pool: pg.Pool,
  roundId: string,
): Promise<CharacterRow[]> {
  const { rows } = await pool.query<CharacterRow>(
    `SELECT t.name, (f.target_id IS NOT NULL) AS found
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

export function createApp(pool: pg.Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(sessionSecret()));

  app.post("/api/rounds", async (req, res) => {
    const sessionId = claimedSession(req) ?? startSession(res);

    await pool.query(
      "INSERT INTO sessions (id) VALUES ($1) ON CONFLICT DO NOTHING",
      [sessionId],
    );

    // The same request resumes a round and starts the next one. What tells them
  // apart is the player's intent, not the shape of the round: arriving at the
  // page wants the round already under way, and pressing "play again" wants a
  // new one. Anything but an exact `true` is not a request to start one.
  const again =
    (req.body as { restart?: unknown } | undefined)?.restart === true;
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
