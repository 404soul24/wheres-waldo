/** The picture as it is drawn on the page right now, in CSS pixels. */
export type RenderedPicture = { x: number; y: number; width: number; height: number };

/** A place on the picture, as a fraction of its width and height (ADR-0002). */
export type Point = { x: number; y: number };

/**
 * Where a press lands on the picture, as a fraction of the picture itself
 * (ADR-0002), or null when it landed on the black beside it. The picture's own
 * box is subtracted before dividing, so zooming and panning change nothing
 * about the answer: one place on the picture is one fraction at every zoom, and
 * a press on the letterbox is nowhere a character can be, so it is nowhere a
 * guess can be made.
 *
 * A box with no area — a picture that has not been laid out yet — has no
 * fraction to give, and returns null rather than a guess.
 */
export function pointOnPicture(
  clickX: number,
  clickY: number,
  picture: RenderedPicture,
): Point | null {
  if (picture.width <= 0 || picture.height <= 0) return null;
  const point = {
    x: (clickX - picture.x) / picture.width,
    y: (clickY - picture.y) / picture.height,
  };
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : null;
}