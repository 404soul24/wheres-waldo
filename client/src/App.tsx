import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { boardNote, formatElapsed } from "./leaderboard.ts";
import type { Board } from "./leaderboard.ts";
import { readMarkers, writeMarkers } from "./markers.ts";
import type { Markers } from "./markers.ts";
import { anchorOn, pickerPosition } from "./picker-position.ts";
import type { ScreenPoint } from "./picker-position.ts";
import { pointOnPicture } from "./point-on-picture.ts";
import type { Point, RenderedPicture } from "./point-on-picture.ts";
import { portraitCrop } from "./portrait.ts";

/**
 * A Character as the server describes it: a name, whether this round has found
 * it, and its Target box in fractions of the picture (ADR-0002). The box is here
 * so a portrait can be cut out of the picture already on screen, rather than
 * carrying a second picture per character that could disagree with this one
 * (ADR-0003).
 */
type Character = {
  name: string;
  found: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};
type Round = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
};
type GuessResponse = {
  hit: boolean;
  characters: Character[];
  round?: Round;
  error?: string;
};

/** What the server says about this session: a round or none, the characters,
 *  and the tag the session plays under. */
type Status = { round: Round | null; characters: Character[]; tag: string | null };

/** Where the picture lives. Also where the portraits are cut from, which is why
 *  it is named rather than written into the markup. */
const PICTURE = "/img/robot-city.jpg";

/** How long a tag may be. The server says the same number in its own tag.ts and
 *  refuses anything longer whatever this browser allows, so this copy is only
 *  there to stop the keyboard letting a player type a tag that will be refused. */
const TAG_MAX = 16;

/**
 * The picture's own box on the page: the very same measurement as
 * RenderedPicture, in the very same pixels, and a DOMRect is one already. Read
 * once and shared, so the Markers, the crosshair and the picker's anchor are
 * all placed against where the picture is now. Only a press reads the box
 * itself, and rightly so: it must divide by the box as it stands at that
 * instant, not by one a render ago.
 */
type Drawn = RenderedPicture;

/**
 * The size of a marker on screen, in pixels, at every zoom. A marker is drawn
 * outside the zoom so that a character found at 1x stays as findable at 2x.
 */
const MARKER_PX = 56;

/**
 * The size of the crosshair on screen, in pixels, at every zoom. It is drawn
 * outside the zoom alongside the Markers, so it too keeps one size on screen.
 */
const AIM_PX = 28;

/** The middle of the picture: where a guess points before a point has been named. */
const MIDDLE: Point = { x: 0.5, y: 0.5 };

/**
 * Arriving at the page asks whether this session has a round yet, and starts
 * nothing. Reading the briefing must not cost the player seconds of a clock
 * they never agreed to start (ADR-0001).
 */
async function arriveAt(): Promise<Status> {
  const response = await fetch("/api/rounds/current");
  if (!response.ok) throw new Error();
  return response.json() as Promise<Status>;
}

/**
 * Asking for a round. Without a tag it resumes the round already under way; a
 * tag is only sent when the player has just chosen one, because playing again
 * says nothing about the name and must not quietly clear it.
 */
async function fetchRound(again: boolean, tag?: string): Promise<Status> {
  const response = await fetch("/api/rounds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(again ? { restart: true } : {}),
      ...(tag === undefined ? {} : { tag }),
    }),
  });
  if (!response.ok) throw new Error();
  return response.json() as Promise<Status>;
}

/**
 * Renaming a session, and what the server decided it is now called. The stored
 * tag is the answer rather than what was asked for, so the client never shows a
 * tag the server did not accept.
 */
async function saveTag(tag: string): Promise<string> {
  const response = await fetch("/api/session", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag }),
  });
  if (!response.ok) throw new Error();
  return ((await response.json()) as { tag: string }).tag;
}

export default function App() {
  const [round, setRound] = useState<Round | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [tag, setTag] = useState<string | null>(null);
  // The briefing, opened by hand. Before the first round there is nothing else
  // to be doing, so it is simply always up; after that it is a courtesy and can
  // be put away. One flag either way, rather than a phase to keep in step.
  const [briefing, setBriefing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [found, setFound] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Markers>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  // Which of the two screens is up. The board is reachable from anywhere and
  // does not need a finished round to be worth looking at, so it is a screen
  // rather than a thing the score dialog owns.
  const [view, setView] = useState<"play" | "board">("play");
  const [board, setBoard] = useState<Board | null>(null);
  // The board's own failure, not the app's: a leaderboard that will not load is
  // no reason to throw away a round already under way.
  const [boardError, setBoardError] = useState<string | null>(null);
  // A rejected tag is kept apart from the board's load error, so it does not
  // replace the whole table: the scores are still true and only the name failed.
  const [tagError, setTagError] = useState<string | null>(null);

  const list = useRef<HTMLElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  // A ref, not the busy state, because a ref is true the instant it is set.
  // The state only arrives with the next render, which is one click too late:
  // a double click on Confirm is two guesses, not one.
  const inFlight = useRef(false);

  // Taking on whatever the server says this session is playing. A round that is
  // not there yet is not an error: it is the briefing being owed, and the
  // characters come back anyway because the briefing is where they are read.
  const adopt = useCallback((next: Status) => {
    setReady(true);
    setCharacters(next.characters);
    setTag(next.tag);
    if (!next.round) return;
    setRound(next.round);
    // Markers are keyed by round, so a new round reads none and starts clean.
    setMarkers(readMarkers(next.round.id));
  }, []);

  useEffect(() => {
    arriveAt()
      .then(adopt)
      .catch(() => setError("We could not reach the server. Please reload."));
  }, [adopt]);

  // Asked for each time the board is opened, so it is the record as it stands
  // rather than as it stood when the round ended. The error is cleared by the
  // button that opens the board, not here: an effect that clears state it is
  // about to set anyway just costs a second render.
  const loadBoard = useCallback(() => {
    return fetch("/api/leaderboard")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body: Board) => {
        // A board that has loaded says so, whatever went wrong last time it
        // did not.
        setBoardError(null);
        setBoard(body);
      })
      .catch(() =>
        setBoardError("We could not load the leaderboard. Please try again."),
      );
  }, []);

  useEffect(() => {
    if (view !== "board") return;
    void loadBoard();
  }, [view, loadBoard]);

  // A Marker stays for the rest of the round, and the round outlives a reload:
  // the server hands back the same round, already part-found. The server keeps
  // only which Characters were found and never where, so the points are this
  // browser's to remember, keyed by round so a new round starts clean.
  useEffect(() => {
    if (!round) return;
    writeMarkers(round.id, markers);
  }, [round, markers]);

  const elapsed = useElapsed(round);

  // The point the player has named on the picture by pressing it, if they have.
  // A press and not a cursor, because a cursor that keeps aiming as it travels
  // to Confirm ends up aiming at the Confirm rather than at the character. It is
  // held as a fraction of the picture (ADR-0002), so zooming and panning move
  // the picture under it without moving the aim off the character. A press with
  // no character chosen still names its point, so a player can point at a
  // figure first and name it second; a player naming by keyboard names nothing
  // at all, and the point is the middle of the picture.
  const [named, setNamed] = useState<Point | null>(null);
  const [placed, setPlaced] = useState<ScreenPoint>({ x: 0, y: 0 });
  const point = named ?? MIDDLE;

  // The picker is placed against the window, so it has to be placed again
  // whenever the window changes shape under it. Resizing with the picker open
  // would otherwise leave it clipped against an edge it was flipped away from.
  // It is anchored to the point on the picture as the picture is drawn now, so
  // it is the same short hop away at every zoom, and it does not chase the
  // pointer: a picker that moves as the pointer approaches it can never be
  // pressed.
  const anchor = drawn ? anchorOn(drawn, point) : { x: 0, y: 0 };
  const anchorX = anchor.x;
  const anchorY = anchor.y;

  const place = useCallback(() => {
    const box = picker.current?.getBoundingClientRect();
    if (!chosen || !box) return;
    setPlaced(
      pickerPosition({ x: anchorX, y: anchorY }, box, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [chosen, anchorX, anchorY]);

  useLayoutEffect(place, [place]);
  useEffect(() => {
    if (!chosen) return;
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [chosen, place]);

  // Escape closes the picker. One listener for the whole window, because the
  // player closes it from anywhere and never has to find it first to close it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChosen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click anywhere that is neither the character list, the Picture nor the
  // picker itself dismisses it. Clicking away is how players say no, and it
  // must not cost them a Guess or a Marker on the Picture.
  useEffect(() => {
    if (!chosen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        !target ||
        list.current?.contains(target) ||
        area.current?.contains(target) ||
        picker.current?.contains(target)
      ) {
        return;
      }
      setChosen(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [chosen]);

  // The picture is the only source of where a guess was made, and it answers in
  // fractions of itself (ADR-0002) — never in the pixels or the zoom that
  // produced them.
  async function guess(name: string, point: Point) {
    if (inFlight.current) return;
    const alreadyFound = characters.some((c) => c.name === name && c.found);
    inFlight.current = true;
    setFailed(null);
    setBusy(true);
    try {
      const response = await fetch("/api/guesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...point }),
      });
      const body = (await response.json()) as GuessResponse;
      if (!response.ok) {
        setFailed(body.error ?? "That guess did not get through.");
        return;
      }
      // What the list says about every Character comes from the server, never
      // from what this Guess hoped for. A Hit for a Character already found is
      // a no-op, so it must not move or add a Marker either.
      setCharacters(body.characters);
      // The round comes back on every answer, because the answer that finds the
      // last Character is the answer that ends the round. Its score is the
      // server's, taken as it stands (ADR-0001).
      setRound((current) => body.round ?? current);
      if (body.hit && !alreadyFound) {
        setMarkers((marks) => ({ ...marks, [name]: point }));
        setFound(`Found ${name}!`);
        setChosen(null);
        setFlash(name);
        setTimeout(() => setFlash((f) => (f === name ? null : f)), 900);
      }
    } catch {
      setFailed("That guess did not reach the server. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (error) return <p className="p-8 text-alert">{error}</p>;
  if (!ready) return <p className="p-8">Loading the picture…</p>;

  // No round yet means the briefing is what this player is owed, and it is the
  // only thing on screen until they say go: the round is not created until they
  // do, so nothing here is being timed.
  if (!round) {
    return (
      <div className="bg-screen text-paper">
        <Briefing characters={characters} tag={tag} busy={busy} onBegin={begin} />
      </div>
    );
  }

  const remaining = characters.filter((c) => !c.found);
  // The whole picture at once, twice, or four times over. 4x is what makes the
  // picture readable on a phone, where the whole thing fits into a strip a
  // couple of hundred pixels wide.
  const nextZoom = zoom === 1 ? 2 : zoom === 2 ? 4 : 1;
  // The score, exactly as the server recorded it and no other way: whatever the
  // tick on this screen believed a moment ago, this is the number that was
  // written down (ADR-0001).
  const score = formatElapsed(round.elapsedMs ?? 0);

  /**
   * Starting a round is what the briefing's button does, and the clock begins
   * here rather than on arrival: nobody is charged for reading the instructions
   * (ADR-0001). The tag goes with it, because this is the moment the player
   * chose one.
   */
  async function begin(chosenTag: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await adopt(await fetchRound(false, chosenTag));
    } catch {
      setFailed("We could not start your round. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /**
   * Renaming changes the tag beside every score this session has ever set and
   * nothing else: no round is created, none is touched, and no clock moves.
   *
   * It reports whether it worked, because the row it was typed into must go
   * back to showing the tag that is actually stored. A board that quietly kept
   * a rejected tag on screen would be telling the player a name they do not
   * have.
   */
  async function retag(next: string): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    try {
      setTag(await saveTag(next));
      setTagError(null);
      await loadBoard();
      return true;
    } catch {
      setTagError("We could not save that tag.");
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  /**
   * Starting again is the same request that loaded the page, saying so: the
   * server hands back a round with nothing found, a clock of its own, and the
   * same six characters. Markers, list and clock all follow from its id.
   */
  async function playAgain() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // Everything the last round said about itself goes with it: the list, the
    // markers and the clock all follow from the round the server hands back,
    // and the banners are the only things left to clear by hand.
    setFailed(null);
    setFound(null);
    setChosen(null);
    // The last round's point goes with it: the next picture is a different one,
    // and the same fraction of a different picture is somewhere else entirely.
    setNamed(null);
    try {
      await adopt(await fetchRound(true));
    } catch {
      setFailed("We could not start a new round. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex h-svh flex-col bg-screen text-paper">
      <header className="flex flex-wrap items-center gap-4 border-b border-beam/40 px-4 py-2">
        <h1 className="text-lg font-bold text-beam">Where&apos;s Waldo</h1>
        <button
          type="button"
          className="rounded border border-beam/50 px-3 py-1 hover:border-beam hover:text-beam"
          onClick={toggleZoom}
        >
          {`Zoom to ${nextZoom}x`}
        </button>
        <button
          type="button"
          className="rounded border border-beam/50 px-3 py-1 hover:border-beam hover:text-beam"
          onClick={() => setBriefing(true)}
        >
          How to play
        </button>
        <button
          type="button"
          className="rounded border border-beam/50 px-3 py-1 hover:border-beam hover:text-beam"
          onClick={() => {
            setBoardError(null);
            setView(view === "board" ? "play" : "board");
          }}
        >
          {view === "board" ? "Back to the picture" : "Leaderboard"}
        </button>
        <span className="ml-auto tabular-nums" aria-label="Time since the round started">
          {formatElapsed(elapsed)}
        </span>
        <span>{remaining.length} of {characters.length} left</span>
      </header>

      <p role="status" className="px-4 py-1 text-sm text-signal empty:hidden">
        {found}
      </p>
      <p role="alert" className="px-4 py-1 text-sm text-alert empty:hidden">
        {failed}
      </p>

      {view === "board" ? (
        <Leaderboard
          board={board}
          error={boardError}
          tagError={tagError}
          onRetag={retag}
        />
      ) : (
      <main className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside ref={list} className="w-full shrink-0 overflow-x-auto border-b border-beam/40 p-4 sm:w-48 sm:overflow-y-auto sm:border-b-0 sm:border-r">
          <ul className="flex list-none gap-4 sm:block sm:space-y-2">
            {characters.map((character) => (
              <li key={character.name}>
                <button
                  type="button"
                  // A found character is out of the game, so a stray second click
                  // on it does nothing at all rather than asking for a guess.
                  disabled={character.found}
                  onClick={() => choose(character.name)}
                  className={`w-auto whitespace-nowrap text-left sm:w-full sm:whitespace-normal ${
                    character.found
                      ? "line-through opacity-40"
                      : chosen === character.name
                        ? "text-beam"
                        : "hover:text-beam"
                  }`}
                >
                  {character.name}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <Picture
          area={area}
          zoom={zoom}
          pan={pan}
          onPan={setPan}
          drawn={drawn}
          onDrawn={setDrawn}
          markers={markers}
          flash={flash}
          aim={chosen ? point : null}
          // A press on the picture is what names a point, so nothing is tracked
          // on every move of a picture-sized element.
          onAim={setNamed}
        />

        {chosen && (
          // A plain element at a point. A dialog would trap focus and dim the
          // picture the player is trying to read, and a player who has just
          // dismissed one should not be left with a focus ring in a void.
          <div
            ref={picker}
            role="group"
            aria-label={`Confirm a guess for ${chosen}`}
            className="fixed z-10 w-52 rounded border border-beam/60 bg-screen p-3 shadow-xl"
            style={{ left: placed.x, top: placed.y }}
          >
            <p className="text-sm font-bold">{chosen}</p>
            <p className="mt-1 text-xs text-beam/70">
              at {(point.x * 100).toFixed(1)}% across, {(point.y * 100).toFixed(1)}% down
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void guess(chosen, point)}
              className="mt-2 w-full rounded bg-beam px-3 py-1 font-bold text-screen hover:bg-paper disabled:opacity-50"
            >
              {busy ? "Guessing…" : "Confirm"}
            </button>
          </div>
        )}
      </main>
      )}

      {briefing && (
        <Briefing
          characters={characters}
          tag={tag}
          busy={busy}
          onBegin={begin}
          onClose={() => setBriefing(false)}
        />
      )}

      {round.finishedAt && view === "play" && (
        // Shown when the round ends, and again on any return to a round that is
        // already over, because the score belongs to the round rather than to
        // the moment it happened.
        <div className="fixed inset-0 z-20 grid place-items-center bg-screen/90 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="score-heading"
            className="w-80 max-w-full rounded border border-beam bg-screen p-6 text-center shadow-xl"
          >
            <h2 id="score-heading" className="text-lg font-bold text-beam">
              All six found
            </h2>
            <p className="mt-1 text-sm text-beam/70">You took</p>
            <p className="my-2 text-4xl tabular-nums" aria-label={`Time taken ${score}`}>
              {score}
            </p>
            <button
              type="button"
              autoFocus
              disabled={busy}
              onClick={() => void playAgain()}
              className="w-full rounded bg-beam px-3 py-2 font-bold text-screen hover:bg-paper disabled:opacity-50"
            >
              {busy ? "Starting…" : "Play again"}
            </button>
            <button
              type="button"
              onClick={() => {
                setBoardError(null);
                setView("board");
              }}
              className="mt-2 w-full rounded border border-beam/60 px-3 py-2 text-sm hover:border-beam hover:text-beam"
            >
              See the leaderboard
            </button>
          </div>
        </div>
      )}

      <Credit />
    </div>
  );

/**
   * Choosing a character is what opens the picker. It does not touch the point:
   * the player has already named where they are looking, and choosing a
   * character afterwards must not throw that away in favour of the middle of
   * the picture.
   */
  function choose(name: string) {
    setFound(null);
    setChosen(name);
  }

  function toggleZoom() {
    // Back to 1x the picture is re-centred: a pan that survived the zoom out
    // would leave it off screen and apparently lost.
    if (nextZoom === 1) setPan({ x: 0, y: 0 });
    setZoom(nextZoom);
  }
}

/**
 * The picture itself, loaded once and shared by every portrait. The page's own
 * <img> is a different element doing a different job; this one exists so six
 * portraits can be cut from the same pixels without six more requests.
 */
let pictureOnce: Promise<HTMLImageElement> | null = null;
function loadPicture(): Promise<HTMLImageElement> {
  return (pictureOnce ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture did not load."));
    image.src = PICTURE;
  }));
}

/**
 * One character, cut out of the picture.
 *
 * The portrait is the picture itself, zoomed to that character's Target box —
 * so it cannot show a face that has drifted from where the character actually
 * is, and there is no second artwork to keep in step (ADR-0003). The name is
 * always beside it in the markup, so the canvas itself says nothing to a screen
 * reader.
 */
function Portrait({ character }: { character: Character }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { x, y, w, h } = character;

  useEffect(() => {
    let still = true;
    loadPicture()
      .then((image) => {
        const target = canvas.current;
        if (!still || !target) return;
        const { sx, sy, size } = portraitCrop(
          { x, y, w, h },
          { width: image.naturalWidth, height: image.naturalHeight },
        );
        target.width = size;
        target.height = size;
        target.getContext("2d")?.drawImage(image, sx, sy, size, size, 0, 0, size, size);
      })
      // A portrait that could not be cut leaves the name beside it, which is
      // still the thing a player is looking for. Nothing here is worth an error.
      .catch(() => {});
    return () => {
      still = false;
    };
  }, [x, y, w, h]);

  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      className="h-12 w-12 shrink-0 border border-beam/50 bg-screen object-cover"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

/**
 * What the player is shown before their first round, and on request afterwards:
 * the six Characters with a face each, the tag they will appear under on the
 * board, and the one button that starts the clock. On the first visit there is
 * nothing behind it and no way past it — the round does not exist yet. Opened
 * later it is read-only, with the tag left where it is and a Close instead.
 */
function Briefing({
  characters,
  tag,
  busy,
  onBegin,
  onClose,
}: {
  characters: Character[];
  tag: string | null;
  busy: boolean;
  onBegin: (tag: string) => void;
  onClose?: () => void;
}) {
  const [draft, setDraft] = useState(tag ?? "");
  // A briefing with no way out is the first visit: the round does not exist
  // until the player presses go, so there is nothing behind it to go back to.
  // One that can be closed is the courtesy re-opening, and it asks for nothing.
  const firstVisit = !onClose;

  return (
    <div
      className={
        firstVisit
          ? "grid min-h-svh place-items-center p-4"
          : "fixed inset-0 z-30 grid place-items-center bg-screen/90 p-4"
      }
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="briefing-heading"
        className="w-full max-w-lg overflow-y-auto rounded border border-beam bg-screen p-6 shadow-xl"
      >
        <h2 id="briefing-heading" className="text-lg font-bold text-beam">
          Robot City
        </h2>
        <p className="mt-2 text-sm text-beam/70">
          Six characters are hiding in this picture. Name one, then click where
          you can see them. {firstVisit ? "The clock starts when you press go." : ""}
        </p>

        <ul className="mt-5 grid list-none grid-cols-1 gap-3 sm:grid-cols-2">
          {characters.map((character) => (
            <li key={character.name} className="flex items-center gap-3">
              <Portrait character={character} />
              <span className="text-sm">{character.name}</span>
            </li>
          ))}
        </ul>

        {firstVisit ? (
          <form
            className="mt-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== "") onBegin(draft);
            }}
          >
            <label htmlFor="briefing-tag" className="text-sm text-beam/70">
              Your tag, as it will appear on the leaderboard
            </label>
            <input
              id="briefing-tag"
              value={draft}
              // The same bound the server enforces, so the keyboard will not let
              // a player type a tag the server would then refuse a round for.
              maxLength={TAG_MAX}
              required
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              className="mt-1 w-full rounded border border-beam/60 bg-screen px-3 py-2"
            />
            <button
              type="submit"
              disabled={busy || draft.trim() === ""}
              className="mt-4 w-full rounded bg-beam px-3 py-2 font-bold text-screen hover:bg-paper disabled:opacity-50"
            >
              {busy ? "Starting…" : "Go"}
            </button>
          </form>
        ) : (
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="mt-6 w-full rounded border border-beam/60 px-3 py-2 hover:border-beam hover:text-beam"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The picture is somebody else's work, and the app says so where the player is
 * rather than in a repository file they will never open. Attribution is not a
 * licence to redistribute, and the credit says exactly that.
 */
function Credit() {
  return (
    <footer className="border-t border-beam/40 px-4 py-2 text-sm text-beam">
      Picture: <span className="font-bold">Robot City</span> by{" "}
      <a
        className="underline hover:text-paper"
        href="https://chekavo.artstation.com/"
        rel="noreferrer noopener"
        target="_blank"
      >
        Egor Klyuchnyk
      </a>
      . Credited, not licensed: this is not a redistribution licence.
    </footer>
  );
}

/**
 * The ten fastest rounds anyone has finished, one row per session on its best
 * score, and the player's own row picked out. Rows are named by an opaque
 * handle and nothing else, so there is nothing here to identify anyone by.
 */
function Leaderboard({
  board,
  error,
  tagError,
  onRetag,
}: {
  board: Board | null;
  error: string | null;
  tagError: string | null;
  onRetag: (tag: string) => Promise<boolean>;
}) {
  if (error) return <p role="alert" className="p-8 text-alert">{error}</p>;
  if (!board) return <p className="p-8">Loading the leaderboard…</p>;
  const note = boardNote(board);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <h2 className="text-lg font-bold text-beam">The ten fastest rounds</h2>
      {note && <p className="mt-2 text-sm text-beam/70">{note}</p>}
      {tagError && <p role="alert" className="mt-2 text-sm text-alert">{tagError}</p>}
      {board.entries.length > 0 && (
        <table className="mt-4 w-full max-w-lg text-sm">
          <thead>
            <tr className="text-left text-beam/70">
              <th className="py-1 pr-4 font-normal">#</th>
              <th className="py-1 pr-4 font-normal">Tag</th>
              <th className="py-1 pr-4 font-normal">Time</th>
              <th className="py-1 font-normal">Finished</th>
            </tr>
          </thead>
          <tbody>
            {board.entries.map((entry, index) => (
              <tr
                key={entry.session}
                // Told apart by a word as well as a colour, so the player's own
                // row is findable without reading the colour.
                className={
                  entry.you
                    ? "bg-beam/15 font-bold text-beam"
                    : "border-t border-beam/30"
                }
              >
                <td className="py-1 pr-4 tabular-nums">
                  {index + 1}
                  {entry.you && <span className="ml-2 text-xs">You</span>}
                </td>
                <td className="py-1 pr-4">
                  {entry.you ? (
                    // Only ever your own row, and it changes nothing but the tag
                    // beside it: no round is touched and no clock moves. A tag
                    // the server refuses puts the stored one back, rather than
                    // leaving the row claiming a name nobody has.
                    <input
                      aria-label="Your tag"
                      defaultValue={entry.tag ?? ""}
                      maxLength={TAG_MAX}
                      onBlur={async (event) => {
                        const field = event.target;
                        const wanted = field.value.trim();
                        if (wanted === (entry.tag ?? "")) return;
                        if (wanted === "") {
                          field.value = entry.tag ?? "";
                          return;
                        }
                        if (!(await onRetag(wanted))) {
                          field.value = entry.tag ?? "";
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      className="w-full max-w-32 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-beam/50 focus:border-beam"
                    />
                  ) : (
                    // A dash rather than a blank cell, so an untagged session
                    // reads as a deliberate absence and not as a broken column.
                    <span className="text-beam/50">{entry.tag ?? "—"}</span>
                  )}
                </td>
                <td className="py-1 pr-4 tabular-nums">{formatElapsed(entry.elapsedMs)}</td>
                <td className="py-1 tabular-nums">
                  {new Date(entry.finishedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function Picture({
  area,
  zoom,
  pan,
  onPan,
  drawn,
  markers,
  flash,
  onAim,
  onDrawn,
  aim,
}: {
  /** The element the click-anywhere-else listener looks for, handed over rather
   * than wrapped in a forwardRef for one ref and no benefit. */
  area: RefObject<HTMLDivElement | null>;
  zoom: number;
  pan: Point;
  onPan: (pan: Point) => void;
  drawn: Drawn | null;
  markers: Markers;
  flash: string | null;
  /** The point a press on the picture named, which becomes the guess. */
  onAim: (point: Point) => void;
  onDrawn: (drawn: Drawn) => void;
  /** The point Confirm would guess at, drawn on the picture so the player can
   * see it rather than infer it from a percentage. */
  aim: Point | null;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [pointer, setPointer] = useState<Point | null>(null);

  // Zooming and panning move the picture, so it has to be measured again: the
  // markers and the picker's anchor are both placed against where it is now.
  const measure = useCallback(() => {
    if (!image.current) return;
    onDrawn(image.current.getBoundingClientRect());
  }, [onDrawn]);

  useLayoutEffect(measure, [measure, zoom, pan]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  /** The point a press names, read off the picture as it stands at that instant.
   * Null for a press on the black beside the picture, which names nothing
   * rather than naming the middle: a stray press must not throw the aim away. */
  function namedAt(clientX: number, clientY: number): Point | null {
    const box = image.current?.getBoundingClientRect();
    return box ? pointOnPicture(clientX, clientY, box) : null;
  }

  return (
    // Zooming and panning are the player's own view of the picture. They never
    // leave the browser: the server is told fractions of the picture, nothing
    // about how it happens to be rendered.
    <div
      ref={area}
      className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-screen"
      style={{
        cursor: zoom === 1 ? "default" : pointer ? "grabbing" : "grab",
        // Taken away from the picture at every zoom, not only when panning is
        // possible: without it the browser claims a touch drag for its own
        // scrolling and cancels the pointer, so a finger cannot pan the picture
        // at all. The page itself never scrolls — the whole game is one screen —
        // so nothing is lost by refusing the gesture here.
        touchAction: "none",
      }}
      onPointerDown={(event) => {
        // A second finger mid-pan neither renames the point nor hijacks the pan.
        if (pointer) return;
        // Naming is not tied to the pointer being still: a pan is a drag from a
        // point on the picture, and that point is a fair one to have named.
        const pressed = namedAt(event.clientX, event.clientY);
        if (pressed) onAim(pressed);
        if (zoom === 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setPointer({ x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        if (!pointer) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        setPointer({ x: event.clientX, y: event.clientY });
        onPan({ x: pan.x + dx, y: pan.y + dy });
      }}
      // Panning ends the pointer's business; the point was named by the press
      // that began it and is not renamed by the drag that followed.
      onPointerUp={() => setPointer(null)}
      onPointerCancel={() => setPointer(null)}
    >
      <img
        ref={image}
        src={PICTURE}
        alt="Robot City, crowded with figures"
        // max-* rather than a fixed size, so the picture is scaled down to fit
        // whatever the viewport is and its own proportions are kept at every one.
        // The crosshair lives on the picture, not on the container, so naming a
        // point reads as naming a point, and stepping off the picture to reach
        // Confirm puts the ordinary cursor back — with no leave handler to
        // forget to write. Only at 1x, where the whole picture is where you
        // name a point; zoomed in, the whole picture is a drag handle and the
        // crosshair drawn on it already says where the point is.
        className={`max-h-full max-w-full ${aim && zoom === 1 ? "cursor-crosshair" : ""}`}
        style={{
          // Scaling the picture rather than resizing it keeps it at full
          // resolution when zoomed, and back to fitting the viewport at 1x. The
          // container centres it, so the scale grows it about its own middle.
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
        onLoad={measure}
        draggable={false}
      />

      {/* The tube's own glass, over the picture and never over the type. Both
          layers ignore the pointer, so they cost the player no clicks. */}
      <div className="scanlines pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="vignette pointer-events-none absolute inset-0" aria-hidden="true" />

      {drawn && (
        // Positioned against the picture's box on the page and not inside the
        // zoom, so a Marker is MARKER_PX on screen whatever the zoom is.
        <div
          className="pointer-events-none fixed"
          style={{
            left: drawn.x,
            top: drawn.y,
            width: drawn.width,
            height: drawn.height,
          }}
        >
          {aim && (
            // The crosshair is the aim, drawn on the picture itself. Without it
            // the player is asked to trust a percentage in a box they are about
            // to click, which is how a guess ends up somewhere nobody pointed.
            <span
              className="absolute block rounded-full border-2 border-dashed border-signal"
              style={{
                left: aim.x * drawn.width,
                top: aim.y * drawn.height,
                width: AIM_PX,
                height: AIM_PX,
                translate: "-50% -50%",
              }}
            />
          )}

          {Object.entries(markers).map(([name, point]) => (
            <span
              key={name}
              className={`absolute block rounded-full border-4 ${
                name === flash
                  ? "animate-ping border-paper"
                  : "border-signal/90"
              }`}
              style={{
                left: point.x * drawn.width,
                top: point.y * drawn.height,
                width: MARKER_PX,
                height: MARKER_PX,
                translate: "-50% -50%",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** How long the round has been running, measured from the start time the server
 * set. The tick only decides how often the display is refreshed; the number
 * itself is the difference of two absolute times, so a hidden tab, a throttled
 * interval or a sleeping laptop catch up rather than lose seconds (ADR-0001).
 *
 * Once the round is over, the server's score is the answer: it is the number
 * that was recorded, and the client is not trusted to agree with it.
 */
function useElapsed(round: Round | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!round || round.finishedAt) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [round]);

  if (!round) return 0;
  if (round.finishedAt) return round.elapsedMs ?? 0;
  return Math.max(0, now - Date.parse(round.startedAt));
}


