import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { readMarkers, writeMarkers } from "./markers.ts";
import type { Markers } from "./markers.ts";
import { pickerPosition } from "./picker-position.ts";
import type { ScreenPoint } from "./picker-position.ts";
import { pointOnPicture } from "./point-on-picture.ts";
import type { Point, RenderedPicture } from "./point-on-picture.ts";

type Character = { name: string; found: boolean };
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
type StartResponse = { round: Round; characters: Character[] };

/**
 * Where the cursor is over the picture: the point it names, as a fraction of
 * the picture (ADR-0002), and the place on the page it is standing.
 */
type Pointing = { point: Point; at: ScreenPoint };

/**
 * The picture's own box on the page: the very same measurement as
 * RenderedPicture, in the very same pixels, and a DOMRect is one already. Read
 * once and shared, so the aim, the Markers and the picker's anchor can never
 * disagree about where the picture is.
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

/** The middle of the picture: where a guess points before the cursor has been. */
const MIDDLE: Point = { x: 0.5, y: 0.5 };

/** Where the middle of the picture is on the page, for anchoring the picker. */
function middleAt(drawn: Drawn | null): ScreenPoint {
  return drawn
    ? { x: drawn.x + drawn.width / 2, y: drawn.y + drawn.height / 2 }
    : { x: 0, y: 0 };
}

/**
 * The round this session is playing. Arriving at the page and asking for
 * another round are the same request, told apart by what the player meant:
 * without `again` the server hands back the round already under way, and with
 * it a new one, started now, with nothing found.
 */
async function fetchRound(again: boolean): Promise<StartResponse> {
  const response = await fetch("/api/rounds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(again ? { restart: true } : {}),
  });
  if (!response.ok) throw new Error();
  return response.json() as Promise<StartResponse>;
}

export default function App() {
  const [round, setRound] = useState<Round | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [found, setFound] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [hover, setHover] = useState<Pointing | null>(null);
  const [markers, setMarkers] = useState<Markers>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [drawn, setDrawn] = useState<Drawn | null>(null);

  const list = useRef<HTMLElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  // A ref, not the busy state, because a ref is true the instant it is set.
  // The state only arrives with the next render, which is one click too late:
  // a double click on Confirm is two guesses, not one.
  const inFlight = useRef(false);

  // Resuming is the same request as starting: the server returns the round this
  // session already has, started when it first arrived, found characters and
  // all. Nothing here keeps a start time of its own (ADR-0001).
  const adopt = useCallback((next: StartResponse) => {
    setRound(next.round);
    setCharacters(next.characters);
    // Markers are keyed by round, so a new round reads none and starts clean.
    setMarkers(readMarkers(next.round.id));
  }, []);

  useEffect(() => {
    fetchRound(false)
      .then(adopt)
      .catch(() => setError("We could not start your round. Please reload."));
  }, [adopt]);

  // A Marker stays for the rest of the round, and the round outlives a reload:
  // the server hands back the same round, already part-found. The server keeps
  // only which Characters were found and never where, so the points are this
  // browser's to remember, keyed by round so a new round starts clean.
  useEffect(() => {
    if (!round) return;
    writeMarkers(round.id, markers);
  }, [round, markers]);

  const elapsed = useElapsed(round);

  // A chosen character is the picker. It opens once, where the cursor stood when
  // the character was chosen, and stays there: a picker that chases the cursor
  // can never be clicked, because moving towards it moves it away. The Guess it
  // will make is the last point the cursor named on the Picture, so leaving the
  // Picture to reach Confirm does not lose the aim. With no cursor yet — a
  // player arriving by keyboard — the point is the middle of the Picture.
  const [at, setAt] = useState<ScreenPoint | null>(null);
  const [placed, setPlaced] = useState<ScreenPoint>({ x: 0, y: 0 });
  const point = hover?.point ?? MIDDLE;

  // The picker is placed against the window, so it has to be placed again
  // whenever the window changes shape under it. Resizing with the picker open
  // would otherwise leave it clipped against an edge it was flipped away from.
  const anchor = at ?? middleAt(drawn);
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

  if (error) return <p className="p-8 text-red-400">{error}</p>;
  if (!round) return <p className="p-8">Loading the picture…</p>;

  const remaining = characters.filter((c) => !c.found);
  // The score, exactly as the server recorded it and no other way: whatever the
  // tick on this screen believed a moment ago, this is the number that was
  // written down (ADR-0001).
  const score = formatElapsed(round.elapsedMs ?? 0);

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
    <div className="flex h-svh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex flex-wrap items-center gap-4 border-b border-neutral-800 px-4 py-2">
        <h1 className="text-lg font-bold">Where&apos;s Waldo</h1>
        <button
          type="button"
          className="rounded border border-neutral-700 px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={toggleZoom}
        >
          {zoom === 1 ? "Zoom in (2x)" : "Zoom out (1x)"}
        </button>
        <span className="ml-auto tabular-nums" aria-label="Time since the round started">
          {formatElapsed(elapsed)}
        </span>
        <span>{remaining.length} of {characters.length} left</span>
      </header>

      <p role="status" className="px-4 py-1 text-sm text-emerald-300 empty:hidden">
        {found}
      </p>
      <p role="alert" className="px-4 py-1 text-sm text-red-400 empty:hidden">
        {failed}
      </p>

      <main className="flex min-h-0 flex-1">
        <aside ref={list} className="w-48 shrink-0 overflow-y-auto border-r border-neutral-800 p-4">
          <ul className="list-none space-y-2">
            {characters.map((character) => (
              <li key={character.name}>
                <button
                  type="button"
                  // A found character is out of the game, so a stray second click
                  // on it does nothing at all rather than asking for a guess.
                  disabled={character.found}
                  onClick={(event) => choose(character.name, event)}
                  className={`w-full text-left focus-visible:outline-2 ${
                    character.found
                      ? "line-through opacity-40"
                      : chosen === character.name
                        ? "text-sky-300"
                        : "hover:text-sky-200"
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
          // Only worth tracking while a character is chosen. Following the
          // cursor on every move of a picture-sized element re-renders the whole
          // board for a number nobody is looking at yet.
          onHover={chosen ? setHover : () => setHover(null)}
        />

        {chosen && (
          // A plain element at a point. A dialog would trap focus and dim the
          // picture the player is trying to read, and a player who has just
          // dismissed one should not be left with a focus ring in a void.
          <div
            ref={picker}
            role="group"
            aria-label={`Confirm a guess for ${chosen}`}
            className="fixed z-10 w-52 rounded border border-neutral-600 bg-neutral-900 p-3 shadow-xl"
            style={{ left: placed.x, top: placed.y }}
          >
            <p className="text-sm font-bold">{chosen}</p>
            <p className="mt-1 text-xs text-neutral-400">
              at {(point.x * 100).toFixed(1)}% across, {(point.y * 100).toFixed(1)}% down
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void guess(chosen, point)}
              className="mt-2 w-full rounded bg-sky-600 px-3 py-1 font-bold hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? "Guessing…" : "Confirm"}
            </button>
          </div>
        )}
      </main>

      {round.finishedAt && (
        // Shown when the round ends, and again on any return to a round that is
        // already over, because the score belongs to the round rather than to
        // the moment it happened.
        <div className="fixed inset-0 z-20 grid place-items-center bg-neutral-950/80">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="score-heading"
            className="w-80 rounded border border-neutral-600 bg-neutral-900 p-6 text-center shadow-xl"
          >
            <h2 id="score-heading" className="text-lg font-bold">
              All six found
            </h2>
            <p className="mt-1 text-sm text-neutral-400">You took</p>
            <p className="my-2 text-4xl tabular-nums" aria-label={`Time taken ${score}`}>
              {score}
            </p>
            <button
              type="button"
              autoFocus
              disabled={busy}
              onClick={() => void playAgain()}
              className="w-full rounded bg-sky-600 px-3 py-2 font-bold hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? "Starting…" : "Play again"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  /**
   * Choosing a character is what opens the picker, and the picker opens where
   * the cursor is, so the player's eye does not have to travel to find it. A
   * cursor that has never been over the picture — a player arriving by keyboard
   * — gets the middle of the picture instead of nothing at all.
   */
  function choose(name: string, event: { clientX: number; clientY: number }) {
    // Enter on a button reports a cursor at the origin, which would anchor the
    // picker in the top left corner: exactly the fixed corner this avoids.
    const cursor =
      event.clientX || event.clientY
        ? { x: event.clientX, y: event.clientY }
        : middleAt(drawn);
    setAt(cursor);
    setFound(null);
    // A character chosen afresh starts from the middle of the picture, not from
    // wherever the mouse last wandered: the player is naming a character now,
    // and carrying an old cursor position into the new guess would fire at a
    // point they never chose.
    setHover(null);
    setChosen(name);
  }

  function toggleZoom() {
    // Back to 1x the picture is re-centred: a pan that survived the zoom out
    // would leave it off screen and apparently lost.
    if (zoom === 2) setPan({ x: 0, y: 0 });
    setZoom(zoom === 1 ? 2 : 1);
  }
}

function Picture({
  area,
  zoom,
  pan,
  onPan,
  drawn,
  markers,
  flash,
  onHover,
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
  onHover: (aim: Pointing | null) => void;
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

  /** Where the cursor is on the picture right now, or null off it. */
  function aimed(clientX: number, clientY: number): Pointing | null {
    const point = onPicture(clientX, clientY, image.current);
    return point ? { point, at: { x: clientX, y: clientY } } : null;
  }

  return (
    // Zooming and panning are the player's own view of the picture. They never
    // leave the browser: the server is told fractions of the picture, nothing
    // about how it happens to be rendered.
    <div
      ref={area}
      className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black"
      style={{
        cursor: zoom === 1 ? "default" : pointer ? "grabbing" : "grab",
        touchAction: zoom === 1 ? undefined : "none",
      }}
      onPointerDown={(event) => {
        if (zoom === 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setPointer({ x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        onHover(aimed(event.clientX, event.clientY));
        if (!pointer) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        setPointer({ x: event.clientX, y: event.clientY });
        onPan({ x: pan.x + dx, y: pan.y + dy });
      }}
      // Deliberately no onPointerLeave: the cursor leaves the picture to reach
      // the Confirm button, and the point it last named is the point it meant.
      onPointerUp={() => setPointer(null)}
      onPointerCancel={() => setPointer(null)}
    >
      <img
        ref={image}
        src="/img/robot-city.jpg"
        alt="Robot City, crowded with figures"
        className="max-h-full max-w-full"
        style={{
          // Scaling the picture rather than resizing it keeps it at full
          // resolution when zoomed, and back to fitting the viewport at 1x. The
          // container centres it, so the scale grows it about its own middle.
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
        onLoad={measure}
        draggable={false}
      />

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
              className="absolute block rounded-full border-2 border-dashed border-sky-300"
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
                  ? "animate-ping border-white"
                  : "border-emerald-400/90"
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

/**
 * Where a click lands on the picture as a fraction of the picture itself
 * (ADR-0002), or null when it landed on the black beside it. The letterbox is
 * not a place a character can be, so it is not a place a guess can be made.
 */
function onPicture(
  clickX: number,
  clickY: number,
  image: HTMLImageElement | null,
): Point | null {
  if (!image) return null;
  const point = pointOnPicture(clickX, clickY, image.getBoundingClientRect());
  return point && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    ? point
    : null;
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

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
