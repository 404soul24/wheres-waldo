import cookieParser from "cookie-parser";
import express from "express";
import type pg from "pg";

import { claimedSession, sessionSecret, startSession } from "./session.ts";

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

export function createApp(pool: pg.Pool) {
  const app = express();
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

    // A player's browser learns which characters exist and which are found,
    // never where any of them are. The target boxes stay on the server: a
    // client that could read them could read the answers out of the page.
    const { rows: characters } = await pool.query<CharacterRow>(
      `SELECT t.name, (f.target_id IS NOT NULL) AS found
         FROM targets t
         LEFT JOIN finds f ON f.target_id = t.id AND f.round_id = $1
        ORDER BY t.id`,
      [round.id],
    );

    res.json({
      round: {
        id: round.id,
        startedAt: round.started_at.toISOString(),
        finishedAt: round.finished_at?.toISOString() ?? null,
        elapsedMs: round.elapsed_ms,
      },
      characters,
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
