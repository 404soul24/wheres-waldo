import { useEffect, useRef, useState } from "react";

import { pointOnPicture } from "./point-on-picture.ts";

type Character = { name: string; found: boolean };
type Round = { id: string; startedAt: string; finishedAt: string | null };
type Point = { x: number; y: number };

export default function App() {
  const [round, setRound] = useState<Round | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });

  // Resuming is the same request as starting: the server returns the round this
  // session already has, started when it first arrived, found characters and
  // all. Nothing here keeps a start time of its own (ADR-0001).
  useEffect(() => {
    fetch("/api/rounds", { method: "POST" })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ round: Round; characters: Character[] }>;
      })
      .then(({ round, characters }) => {
        setRound(round);
        setCharacters(characters);
      })
      .catch(() => setError("We could not start your round. Please reload."));
  }, []);

  const elapsed = useElapsed(round);

  // The picture is the only source of where a guess was made, and it answers in
  // fractions of itself (ADR-0002) — never in the pixels or the zoom that
  // produced them.
  async function guess(name: string, point: Point) {
    const response = await fetch("/api/guesses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...point }),
    });
    if (!response.ok) return;
    const { characters } = (await response.json()) as { characters: Character[] };
    setCharacters(characters);
  }

  if (error) return <p className="p-8 text-red-400">{error}</p>;
  if (!round) return <p className="p-8">Loading the picture…</p>;

  const remaining = characters.filter((c) => !c.found);

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

      <main className="flex min-h-0 flex-1">
        <aside className="w-48 shrink-0 overflow-y-auto border-r border-neutral-800 p-4">
          <ul className="list-none space-y-2">
            {characters.map((character) => (
              <li key={character.name}>
                <button
                  type="button"
                  disabled={character.found}
                  onClick={() => setChosen(character.name)}
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
          zoom={zoom}
          pan={pan}
          onPan={setPan}
          onPoint={chosen ? (point) => void guess(chosen, point) : undefined}
        />
      </main>
    </div>
  );

  function toggleZoom() {
    // Back to 1x the picture is re-centred: a pan that survived the zoom out
    // would leave it off screen and apparently lost.
    if (zoom === 2) setPan({ x: 0, y: 0 });
    setZoom(zoom === 1 ? 2 : 1);
  }
}

function Picture({
  zoom,
  pan,
  onPan,
  onPoint,
}: {
  zoom: number;
  pan: Point;
  onPan: (pan: Point) => void;
  onPoint?: (point: Point) => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [dragged, setDragged] = useState(false);

  return (
    // Zooming and panning are the player's own view of the picture. They never
    // leave the browser: the server is told fractions of the picture, nothing
    // about how it happens to be rendered.
    <div
      className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black"
      style={{
        cursor: zoom === 1 ? "default" : pointer ? "grabbing" : "grab",
        touchAction: zoom === 1 ? undefined : "none",
      }}
      onPointerDown={(event) => {
        setDragged(false);
        if (zoom === 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setPointer({ x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        if (!pointer) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        setDragged(true);
        setPointer({ x: event.clientX, y: event.clientY });
        onPan({ x: pan.x + dx, y: pan.y + dy });
      }}
      onPointerUp={(event) => {
        setPointer(null);
        if (dragged || !onPoint || !image.current) return;
        const point = pointOnPicture(event.clientX, event.clientY, image.current.getBoundingClientRect());
        if (point) onPoint(point);
      }}
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
        draggable={false}
      />
    </div>
  );
}

/**
 * How long the round has been running, measured from the start time the server
 * set. The tick only decides how often the display is refreshed; the number
 * itself is the difference of two absolute times, so a hidden tab, a throttled
 * interval or a sleeping laptop catch up rather than lose seconds (ADR-0001).
 */
function useElapsed(round: Round | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!round || round.finishedAt) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [round]);

  if (!round) return 0;
  const end = round.finishedAt ? Date.parse(round.finishedAt) : now;
  return Math.max(0, end - Date.parse(round.startedAt));
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}