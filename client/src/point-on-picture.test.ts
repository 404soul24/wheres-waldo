import { expect, test } from "vitest";

import { pointOnPicture } from "./point-on-picture.ts";

// A picture 1000x500 sitting at the top left of the page, as it is at 1x.
const at1x = { x: 0, y: 0, width: 1000, height: 500 };

test("the top left corner of the picture is the origin", () => {
  expect(pointOnPicture(0, 0, at1x)).toEqual({ x: 0, y: 0 });
});

test("the far corner is one", () => {
  expect(pointOnPicture(1000, 500, at1x)).toEqual({ x: 1, y: 1 });
});

test("the middle is a half", () => {
  expect(pointOnPicture(500, 250, at1x)).toEqual({ x: 0.5, y: 0.5 });
});

test("a picture zoomed to 2x and panned across the page gives the same fraction", () => {
  // The same place on the picture, at 2x and offset by where it sits on the
  // page: one number for one place, whatever the picture is rendered at.
  expect(pointOnPicture(1500, 290, { x: 300, y: 40, width: 2000, height: 1000 })).toEqual({
    x: 0.6,
    y: 0.25,
  });
  expect(pointOnPicture(1500, 290, { x: 300, y: 40, width: 2000, height: 1000 })).toEqual(
    pointOnPicture(600, 125, at1x),
  );
});

test("a picture with no area has no fraction to divide by", () => {
  expect(pointOnPicture(10, 10, { x: 0, y: 0, width: 0, height: 500 })).toBeNull();
  expect(pointOnPicture(10, 10, { x: 0, y: 0, width: 1000, height: 0 })).toBeNull();
});