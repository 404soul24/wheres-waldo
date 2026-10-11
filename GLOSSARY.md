# Where's Waldo

A hidden-object tagging game. The player is shown one crowded picture and must locate every named character hidden in it, as fast as they can.

## Language

**Character**:
A named figure the player must find in the picture — Waldo, the Wizard, Wilma. Distinct from the hundreds of anonymous figures in the same picture.
_Avoid_: Target, robot, person, item

**Picture**:
The single crowded illustration a round is played on. There is one per round, and it does not change mid-round.
_Avoid_: Image, photo, map, board, level

**Target box**:
The region of the picture a character occupies. A guess counts as a hit when it falls inside the character it names. Expressed as a fraction of the picture's width and height, never in pixels.
_Avoid_: Hitbox, bounding box, coordinates, rect, zone

**Guess**:
A claim that a named character sits at a particular point in the picture. One guess names one character and one point.
_Avoid_: Click, attempt, submission, selection

**Hit**:
A guess whose point falls inside the target box of the character it names.
_Avoid_: Correct, success, win

**Miss**:
A guess whose point falls outside the target box of the character it named. Carries no penalty and no time cost.
_Avoid_: Wrong, error, failure, penalty

**Marker**:
The ring drawn on the picture at a character's location once it has been found. It stays for the rest of the round and marks the character as found.
_Avoid_: Circle, pin, indicator, highlight, check

**Round**:
One attempt at a picture, from the moment it loads until every character is found. A round is abandoned by leaving; leaving does not end it.
_Avoid_: Game, session, play, match

**Session**:
An anonymous player's identity, established on first visit and remembered for 30 days. No account, no password, no email.
_Avoid_: User, account, player, identity, cookie

**Tag**:
The display name a Session presents on the Leaderboard. Chosen by the player, editable at any time, and attached to the Session rather than to any single Round. Not an identity: nothing is verified, and two Sessions may share one.
_Avoid_: Name, username, handle, alias, nickname, player name

**Score**:
How long the round took, in milliseconds. Lower is better. Computed from when the round started, never from what the player reports.
_Avoid_: Time, duration, result, points

**Leaderboard**:
The ten fastest scores across all sessions, one row per session — a session's best score only, never its later ones. An anonymous session may appear once even after playing repeatedly. Each row carries the session's Tag; a session that never chose one shows without a name.
_Avoid_: High scores, top ten, ranking, table