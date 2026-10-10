import { expect, test } from "vitest";

import { boardNote, formatElapsed } from "./leaderboard.ts";
import type { Board, Entry } from "./leaderboard.ts";

const entry = (over: Partial<Entry> = {}): Entry => ({
  session: "a-session",
  elapsedMs: 30_000,
  finishedAt: "2026-01-01T00:00:00.000Z",
  you: false,
  ...over,
});

const board = (over: Partial<Board> = {}): Board => ({
  entries: [entry({ elapsedMs: 10_000 }), entry({ elapsedMs: 20_000 })],
  yours: null,
  ...over,
});

test("a time reads as minutes and seconds", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(9_000)).toBe("0:09");
  expect(formatElapsed(75_000)).toBe("1:15");
});

test("a player on the board is told nothing extra", () => {
  expect(
    boardNote(
      board({
        entries: [entry({ elapsedMs: 10_000, you: true })],
        yours: { elapsedMs: 10_000 },
      }),
    ),
  ).toBeNull();
});

test("the first and only score needs no note and no table is lost", () => {
  // Nobody else has played, so there is no cut to have missed and nothing to
  // say: the player is ranked first and sees it.
  expect(boardNote(board({ entries: [], yours: { elapsedMs: 30_000 } }))).toBeNull();
});

test("a player who finished but is not on the board is told their time and the cut", () => {
  const note = boardNote(
    board({
      entries: Array.from({ length: 10 }, (_, i) => entry({ elapsedMs: (i + 1) * 1_000 })),
      yours: { elapsedMs: 91_000 },
    }),
  );

  expect(note).toContain("1:31");
  expect(note).toContain("outside the top ten");
});

test("an empty board explains itself rather than showing a bare table", () => {
  expect(boardNote(board({ entries: [] }))).toContain("No round has been finished");
});

test("a board of other people's scores needs no note", () => {
  expect(boardNote(board())).toBeNull();
});