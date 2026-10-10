import type { Point } from "./point-on-picture.ts";

export type Markers = Record<string, Point>;

/** Where this browser keeps its Markers for a round. */
export const markerKey = (roundId: string) => `ww:markers:${roundId}`;

/**
 * A Marker's point is stored as a fraction of the Picture (ADR-0002), keyed by
 * round so that a new round starts clean and two rounds never share a Marker.
 * Storage is best-effort: a browser that refuses it costs the Markers across a
 * reload, which is not worth an error in the player's face.
 */
export function writeMarkers(roundId: string, markers: Markers): void {
  try {
    sessionStorage.setItem(markerKey(roundId), JSON.stringify(markers));
  } catch {
    // See above: nothing to do but carry on without them.
  }
}

/**
 * The Markers this browser left for a round, or none at all.
 *
 * What comes back out of storage is untrusted, the same as anything else from
 * outside the program: a Marker's point is the only thing here allowed to reach
 * the Picture, so a value that is not a fraction of it is dropped rather than
 * clamped. Clamping would quietly move a Marker to a place nobody found.
 */
export function readMarkers(roundId: string): Markers {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(markerKey(roundId)) ?? "null",
    );
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(
      Object.entries(saved).flatMap(([name, point]) => {
        const { x, y } = point as Partial<Point>;
        return typeof x === "number" && typeof y === "number" &&
          x >= 0 && x <= 1 && y >= 0 && y <= 1
          ? [[name, { x, y }]]
          : [];
      }),
    );
  } catch {
    return {};
  }
}
