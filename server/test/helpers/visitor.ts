import type pg from "pg";

export type Character = { name: string; found: boolean };

export type Round = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
};

export type StartResponse = { round: Round; characters: Character[] };

export type GuessResponse = {
  hit: boolean;
  characters: Character[];
  round?: Round;
  error?: string;
};

/** The six characters of the picture, in the order the server lists them. */
export const CHARACTERS = [
  "Wanda, the pink dancer",
  "Spike, the shark",
  "Diablo, the red devil",
  "Lemkin, the yellow creature",
  "Vince, the detective",
  "Boris, the blue hologram",
];

/**
 * One visitor, over HTTP, keeping their cookie between calls the way a browser
 * would. Nothing here reaches inside the server: every call is a request, and
 * what comes back is what that visitor would see.
 */
export function visitor(baseUrl: string, pool: pg.Pool) {
  let cookie = "";

  /** Arrive at the page: the round already under way, or a new one. */
  const start = async (body?: unknown) => {
    const res = await fetch(`${baseUrl}/api/rounds`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    return { res, body: (await res.json()) as StartResponse };
  };

  /** Press "play again": a new round, whatever the last one did. */
  const playAgain = () => start({ restart: true });

  const guess = async (body: unknown) => {
    const res = await fetch(`${baseUrl}/api/guesses`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as GuessResponse };
  };

  /** A guess that lands: the middle of the seeded target box for that character. */
  const find = async (name: string, extra: Record<string, unknown> = {}) => {
    const { x, y } = await centreOf(pool, name);
    return guess({ name, x, y, ...extra });
  };

  return { start, playAgain, guess, find };
}

/** The middle of a character's seeded target box: a guess that must land. */
export async function centreOf(
  pool: pg.Pool,
  name: string,
): Promise<{ x: number; y: number }> {
  const { rows } = await pool.query(
    "SELECT (x + w / 2) AS x, (y + h / 2) AS y FROM targets WHERE name = $1",
    [name],
  );
  return rows[0] as { x: number; y: number };
}