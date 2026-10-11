import { describe, expect, it } from "vitest";

import { portraitCrop } from "./portrait.ts";

/** The picture as it actually is: 1920 wide, 3858 tall. */
const PICTURE = { width: 1920, height: 3858 };

describe("portraitCrop", () => {
  it("takes a square around a character in the middle of the picture", () => {
    const crop = portraitCrop({ x: 0.25, y: 0.5, w: 0.05, h: 0.05 }, PICTURE, 0);

    // The box is 0.05 of the picture wide but 0.05 of 3858 tall, so the taller
    // side decides the square: 192.9 pixels.
    expect(crop.size).toBeCloseTo(192.9, 1);
    expect(crop.sx + crop.size / 2).toBeCloseTo(0.275 * 1920, 1);
    expect(crop.sy + crop.size / 2).toBeCloseTo(0.525 * 3858, 1);
  });

  it("uses the wider of the two sides, so a tall character is not cut in half", () => {
    const tall = portraitCrop({ x: 0.5, y: 0.5, w: 0.01, h: 0.2 }, PICTURE, 0);
    const wide = portraitCrop({ x: 0.5, y: 0.5, w: 0.2, h: 0.01 }, PICTURE, 0);

    expect(tall.size).toBeCloseTo(771.6, 1);
    expect(wide.size).toBeCloseTo(384, 1);
  });

  it("leaves a little air around the box, so a face is not cropped to the bone", () => {
    const bare = portraitCrop({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, PICTURE, 0);
    const padded = portraitCrop({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, PICTURE, 0.2);

    expect(bare.size).toBeCloseTo(385.8, 1);
    expect(padded.size).toBeCloseTo(385.8 * 1.4, 1);
  });

  it("never reaches past the left or top edge of the picture", () => {
    const crop = portraitCrop({ x: 0, y: 0, w: 0.05, h: 0.01 }, PICTURE, 0.2);

    expect(crop.sx).toBe(0);
    expect(crop.sy).toBe(0);
  });

  it("never reaches past the right or bottom edge", () => {
    const crop = portraitCrop(
      { x: 0.98, y: 0.99, w: 0.02, h: 0.01 },
      PICTURE,
      0.5,
    );

    expect(crop.sx + crop.size).toBeLessThanOrEqual(PICTURE.width);
    expect(crop.sy + crop.size).toBeLessThanOrEqual(PICTURE.height);
  });

  it("stays a whole square inside a picture narrower than the character", () => {
    // A wide character in a small picture cannot have a square as big as the
    // character; it gets the whole picture rather than a hole in it.
    const crop = portraitCrop({ x: 0, y: 0, w: 1, h: 0.5 }, { width: 100, height: 100 });

    expect(crop.size).toBe(100);
    expect(crop.sx).toBe(0);
    expect(crop.sy).toBe(0);
  });

  it("gives the same square every time, for the same character", () => {
    const box = { x: 0.14, y: 0.17, w: 0.075, h: 0.085 };

    expect(portraitCrop(box, PICTURE)).toEqual(portraitCrop(box, PICTURE));
  });
});