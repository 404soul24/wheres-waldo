import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isInside } from "../src/target-box.ts";

// Binary-friendly values so the edge cases test the predicate rather than
// floating-point drift in `x + w`.
const BOX = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };

describe("isInside", () => {
  it("accepts a point in the interior", () => {
    assert.equal(isInside(0.5, 0.6, BOX), true);
  });

  it("accepts a point on each edge, because the edges belong to the character", () => {
    assert.equal(isInside(0.25, 0.6, BOX), true, "left edge");
    assert.equal(isInside(0.75, 0.6, BOX), true, "right edge");
    assert.equal(isInside(0.5, 0.5, BOX), true, "top edge");
    assert.equal(isInside(0.5, 0.75, BOX), true, "bottom edge");
  });

  it("accepts every corner", () => {
    const corners: [number, number][] = [
      [0.25, 0.5],
      [0.75, 0.5],
      [0.25, 0.75],
      [0.75, 0.75],
    ];
    for (const [cx, cy] of corners) {
      assert.equal(isInside(cx, cy, BOX), true, `corner ${cx},${cy}`);
    }
  });

  it("rejects a point outside each edge", () => {
    assert.equal(isInside(0.2, 0.6, BOX), false, "left of it");
    assert.equal(isInside(0.8, 0.6, BOX), false, "right of it");
    assert.equal(isInside(0.5, 0.4, BOX), false, "above it");
    assert.equal(isInside(0.5, 0.8, BOX), false, "below it");
  });

  it("rejects a point inside the box's span on the other axis", () => {
    assert.equal(isInside(0.1, 0.6, BOX), false);
    assert.equal(isInside(0.9, 0.6, BOX), false);
    assert.equal(isInside(0.5, 0.1, BOX), false);
    assert.equal(isInside(0.5, 0.9, BOX), false);
  });

  it("treats a degenerate box as containing only its own line", () => {
    const sliver = { x: 0.5, y: 0.5, w: 0, h: 0 };
    assert.equal(isInside(0.5, 0.5, sliver), true);
    assert.equal(isInside(0.6, 0.5, sliver), false);
  });

  it("spans the whole picture for a full-bleed box", () => {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    assert.equal(isInside(0, 0, full), true);
    assert.equal(isInside(1, 1, full), true);
    assert.equal(isInside(0.5, 0.5, full), true);
  });
});
