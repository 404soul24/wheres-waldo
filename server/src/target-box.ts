/** A character's region of the picture, as fractions of its width and height. */
export type TargetBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * The single place a guess becomes a hit. Edges belong to the character, so a
 * guess exactly on the boundary is a hit. Both arguments are fractions of the
 * picture, never pixels (ADR-0002).
 */
export function isInside(
  guessX: number,
  guessY: number,
  box: TargetBox,
): boolean {
  return (
    guessX >= box.x &&
    guessX <= box.x + box.w &&
    guessY >= box.y &&
    guessY <= box.y + box.h
  );
}
