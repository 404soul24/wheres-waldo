export type Entry = {
  session: string;
  elapsedMs: number;
  finishedAt: string;
  you: boolean;
};

export type Board = {
  entries: Entry[];
  yours: { elapsedMs: number } | null;
};

/** How long a round has been running, as m:ss. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * What the board says above the table, or nothing at all.
 *
 * Two cases are worth words rather than a bare table: a board nobody has scored
 * on yet, which would otherwise look broken, and a player whose own time fell
 * short of the cut, which would otherwise look like they had never played.
 */
export function boardNote(board: Board): string | null {
  // On the board already, whether by a row or by being the only score on it:
  // either way there is nothing to tell them about missing a cut they made.
  if (board.entries.some((entry) => entry.you)) return null;
  if (!board.yours) {
    return board.entries.length === 0
      ? "No round has been finished yet. Finish one to take your place."
      : null;
  }
  // No rows at all alongside a score would be a board saying its own player is
  // outside the top nothing; there is no cut to have missed, so say nothing.
  if (board.entries.length === 0) return null;
  return `Your best was ${formatElapsed(board.yours.elapsedMs)} — outside the top ten.`;
}