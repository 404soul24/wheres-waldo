/** A character's Target box, in fractions of the picture (ADR-0002). */
export type Box = { x: number; y: number; w: number; h: number };

/** A square of the picture, in the picture's own pixels, top-left corner first. */
export type Crop = { sx: number; sy: number; size: number };

/**
 * The square of picture that shows one character whole.
 *
 * The portrait is cut out of the picture the player is already looking at rather
 * than from a second piece of artwork per character, so there is nothing that
 * can drift out of step with where the character actually is (ADR-0003). The
 * box arrives as fractions; this is where they become the picture's own pixels,
 * and the only place in the client that does it.
 *
 * The square is sized by whichever side of the box is longer, so a tall
 * character is not cropped down to its waist, and then padded, so a face is not
 * cropped to the bone. A box near an edge would push that square off the
 * picture, so the square is nudged back until it fits rather than allowed to
 * draw from nothing.
 */
export function portraitCrop(
  box: Box,
  picture: { width: number; height: number },
  pad = 0.2,
): Crop {
  const side = Math.min(
    Math.max(box.w * picture.width, box.h * picture.height) * (1 + 2 * pad),
    picture.width,
    picture.height,
  );
  const centreX = (box.x + box.w / 2) * picture.width;
  const centreY = (box.y + box.h / 2) * picture.height;

  return {
    sx: Math.min(Math.max(centreX - side / 2, 0), picture.width - side),
    sy: Math.min(Math.max(centreY - side / 2, 0), picture.height - side),
    size: side,
  };
}