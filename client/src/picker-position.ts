/** A point on the page, in CSS pixels measured from the top left of the window. */
export type ScreenPoint = { x: number; y: number };

/** Something with a width and a height, in the same pixels. */
export type Box = { width: number; height: number };

/** How far the picker keeps clear of the point it is anchored to, so the
 * character under the cursor stays visible beside it. */
const GAP = 8;

/**
 * Where a picker of a known size should sit so that it opens beside the point
 * the player clicked and is never clipped by the edge of the window.
 *
 * It opens below and to the right of the point, which is where the hand
 * already is. Failing that it flips up and to the left, and failing that it is
 * pushed back inside: a picker the player cannot see all of is a picker they
 * cannot use. The returned point is in viewport pixels, so the picker is
 * positioned with `position: fixed` and never moves with the page beneath it.
 */
export function pickerPosition(
  anchor: ScreenPoint,
  picker: Box,
  viewport: Box,
): ScreenPoint {
  const left =
    anchor.x + GAP + picker.width > viewport.width
      ? anchor.x - GAP - picker.width
      : anchor.x + GAP;
  const top =
    anchor.y + GAP + picker.height > viewport.height
      ? anchor.y - GAP - picker.height
      : anchor.y + GAP;

  return {
    x: clamp(left, viewport.width - picker.width),
    y: clamp(top, viewport.height - picker.height),
  };
}

function clamp(value: number, limit: number): number {
  return Math.min(Math.max(value, 0), Math.max(0, limit));
}
