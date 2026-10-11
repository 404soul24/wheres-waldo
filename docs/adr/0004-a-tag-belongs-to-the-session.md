# A Tag belongs to the Session, not the Round

A Tag is the display name a Session presents on the leaderboard. It is stored once, on `sessions.tag`, and edited through `PATCH /api/session`. It is not copied onto a round when that round is scored.

## Why

Everything else about a score in this model is per-round: `started_at`, `finished_at`, `elapsed_ms`, the finds. The leaderboard is the one place that is not. It keeps a session's *best* score and discards every other round that session played (see `LEADERBOARD` in `server/src/app.ts`). So the row on the board is not a round — it is a session's best round, with the rest thrown away.

That makes "whose name goes on this row?" a question with no round-shaped answer. A row can be older than the player's current tag: they play, score 90 seconds, rename themselves to Ada, play again for 40 seconds, and the board now shows one row — their best — carrying whichever name is true *now*. Storing the tag per round would have meant the name a player chose during the round that set their best score, which is a rule nobody would design on purpose and which would change retroactively every time someone edited their name.

Storing it on the session makes the leaderboard read `JOIN sessions`, one row of truth, and renaming retouches nothing: no round is created, none is finished, no clock moves. The trade-off is that an old score can end up carrying a newer name. For a friendly board with no accounts that is the right way round — a player's current name is the one they want shown.

## What it is not

A Tag is not an identity. Nothing verifies it, nothing is unique about it, and two Sessions may claim the same one — `GLOSSARY.md` says so, and the table holds no address, no email and no account. It is a name the player chose to be called on a board, and the only rules on it are that it is non-empty and at most sixteen characters, enforced twice: in `src/tag.ts` at the boundary, and again as a CHECK constraint so the invariant holds however the row was written.