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

    // A session has at most one round, and the database is what enforces it.
    // Upserting rather than selecting first is what makes two simultaneous
    // requests for a brand new session produce one round rather than a clash.
    const { rows } = await pool.query<RoundRow>(
      `INSERT INTO rounds (session_id) VALUES ($1)
         ON CONFLICT (session_id) DO UPDATE SET session_id = EXCLUDED.session_id
       RETURNING id, started_at, finished_at, elapsed_ms`,
      [sessionId],
    );
    const round = rows[0]!;

    res.json({
      round: {
        id: round.id,
        startedAt: round.started_at.toISOString(),
        finishedAt: round.finished_at?.toISOString() ?? null,
        elapsedMs: round.elapsed_ms,
      },
      characters: await characters(pool, round.id),
    });
  });

  app.post("/api/guesses", async (req, res) => {
    const guess = parseGuess(req.body);
    if (!guess) {
      res.status(400).json({ error: "A guess is one character and one point on the picture." });
      return;
    }

    const sessionId = claimedSession(req);
    const { rows: rounds } = sessionId
      ? await pool.query<RoundRow>("SELECT * FROM rounds WHERE session_id = $1", [sessionId])
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
    // never has to work out what a miss did or a hit did not.
    res.json({ hit, characters: await characters(pool, round.id) });
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
