# Target boxes cross the wire

The server sends each Character's target box (`x`, `y`, `w`, `h`) to the browser, alongside its name and whether the round has found it. Until this was decided, `characters()` returned a name and a found flag and nothing else, and two tests asserted that the boxes were never sent.

## Why

The briefing shows a face next to each Character's name, cut out of the picture the player is already looking at. That portrait can come from two places: a separate piece of artwork per character, or the picture itself, cropped to the box the server already holds.

Cropping from the picture wins on every axis. It is the only option with no second source of truth, so a portrait cannot show a face that has drifted from where the character actually is. It is also the only option that costs nothing — the browser has the picture loaded already, and a canvas crop is a few lines. Shipping six commissioned portraits, or six hand-cropped files, would mean a column in `targets`, a second thing to update whenever a box moves, and artwork that has to be re-cut every time the seed changes.

The price is that a player can open devtools, read the response, and learn where all six characters are. That was weighed and accepted: this is a single-player game with no accounts and nothing at stake but a friendly leaderboard, and the information is not secret in any meaningful sense — it is visible in the picture the player is looking at. What the boxes do protect is *integrity*, not secrecy: a guess is only ever judged by the server against the stored box, so nothing about the answer can be spoofed by reading them.

The alternative was a build step that pre-crops six PNGs from the picture before the client is bundled, keeping the boxes server-side. It needs an image encoder as a devDependency (Node has none), a script that reads the boxes out of the database, and six committed binaries — real machinery, and a stale-portrait failure mode, bought to protect something worth nothing here.

## What this does not change

The boxes are still fractions (ADR-0002), so the same numbers describe the same place at any rendered size. A guess is still only ever resolved server-side, so reading the boxes cannot make a wrong guess land. What changed is only who is allowed to *see* them.

One thing this does force is the first pixel arithmetic in the client. `portrait.ts` turns a character's box into a source rectangle for a canvas, because a canvas can only be drawn from pixels. That is the same carve-out ADR-0002 already allows for rendering — the fraction becomes a pixel at the last moment, in the browser, on the way to a canvas and to nowhere else. It reads the box and never writes back over it. `AGENTS.md` was amended in the same change to say so explicitly, because the rule as written ("do not introduce pixel math") was broader than the reason the rule exists.

## If this ever needs to be reversed

Removing the boxes from the response is a one-line change to `characters()`. The portraits are the thing that depends on them, and they would have to go to a build step or be dropped — which is why the tests that once asserted the boxes were hidden now assert they are sent, so the reversal has to be deliberate rather than accidental.