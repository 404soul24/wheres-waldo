/** The picture as it is drawn on the page right now, in CSS pixels. */
export type RenderedPicture = { x: number; y: number; width: number; height: number };

/**
 * Where a click lands on the picture, as a fraction of the picture itself
 * (ADR-0002). The picture's own box is subtracted before dividing, so zooming
 * and panning change nothing about the answer.
 *
 * A box with no area — a picture that has not been laid out yet — has no
 * fraction to give, and returns null rather than a guess.
 */
export function pointOnPicture(
  clickX: number,
  clickY: number,
  picture: RenderedPicture,
): { x: number; y: number } | null {
  if (picture.width <= 0 || picture.height <= 0) return null;
  return {
    x: (clickX - picture.x) / picture.width,
    y: (clickY - picture.y) / picture.height,
  };
}