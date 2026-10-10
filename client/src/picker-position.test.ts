import { expect, test } from "vitest";

import { anchorOn, pickerPosition } from "./picker-position.ts";
import type { RenderedPicture } from "./point-on-picture.ts";

// A picker about the size of a button with two lines on it, and a window with
// room to move in: the ordinary case, where the cursor is nowhere near an edge.
// The picker keeps a gap of 8px clear of the point it is anchored to.
const picker = { width: 180, height: 90 };
const viewport = { width: 1000, height: 800 };

// The picture as it is drawn at 1x, and the same picture zoomed to 2x and panned
// down the page, which is the whole of what zooming does to it.
const at1x: RenderedPicture = { x: 0, y: 0, width: 1000, height: 500 };
const at2x: RenderedPicture = { x: 300, y: 40, width: 2000, height: 1000 };

test("the anchor is the named point as the picture is drawn right now", () => {
  // One place on the picture is one anchor at 1x...
  expect(anchorOn(at1x, { x: 0.6, y: 0.25 })).toEqual({ x: 600, y: 125 });
  // ...and the same place once the picture has been zoomed and panned, so the
  // picker is still opened beside the point rather than beside where it was.
  expect(anchorOn(at2x, { x: 0.6, y: 0.25 })).toEqual({ x: 1500, y: 290 });
});

test("the picker opens beside the point, below and to the right of it", () => {
  expect(pickerPosition({ x: 400, y: 300 }, picker, viewport)).toEqual({
    x: 408,
    y: 308,
  });
});

test("the picker flips to the left of the point rather than off the right edge", () => {
  expect(pickerPosition({ x: 900, y: 300 }, picker, viewport)).toEqual({
    x: 712,
    y: 308,
  });
});

test("the picker flips above the point rather than off the bottom edge", () => {
  expect(pickerPosition({ x: 400, y: 780 }, picker, viewport)).toEqual({
    x: 408,
    y: 682,
  });
});

test("the picker flips in both directions at a bottom right corner", () => {
  expect(pickerPosition({ x: 900, y: 780 }, picker, viewport)).toEqual({
    x: 712,
    y: 682,
  });
});

test("the picker stays wholly inside a window too small to hold it open anywhere", () => {
  // Nowhere to flip to, so it is pinned to the corner rather than half off it.
  expect(pickerPosition({ x: 10, y: 10 }, picker, { width: 100, height: 60 })).toEqual({
    x: 0,
    y: 0,
  });
});

test("a point outside the window still yields a picker inside it", () => {
  const { x, y } = pickerPosition({ x: -50, y: 900 }, picker, viewport);
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x + picker.width).toBeLessThanOrEqual(viewport.width);
  expect(y + picker.height).toBeLessThanOrEqual(viewport.height);
});

test("a point in the middle of the window is left uncovered by the picker", () => {
  // The gap exists so the character being pointed at stays visible under the
  // picker: the player can see what they are about to claim.
  const point = { x: 500, y: 400 };
  const { x, y } = pickerPosition(point, picker, viewport);
  const covered =
    point.x >= x && point.x <= x + picker.width &&
    point.y >= y && point.y <= y + picker.height;
  expect(covered).toBe(false);
});
