import { beforeEach, expect, test, vi } from "vitest";

import { markerKey, readMarkers, writeMarkers } from "./markers.ts";

const ROUND = "a-round";
const WANDA = "Wanda, the pink dancer";

/**
 * Just enough sessionStorage to hold a string per round, stubbed rather than
 * pulled in a DOM to be had: these tests are about what the code does with what
 * it finds there, not about whether a browser stores it.
 */
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.stubGlobal("localStorage", {});
});

/** Puts a raw string where the markers for a round are kept. */
function store(value: string) {
  sessionStorage.setItem(markerKey(ROUND), value);
}

test("no markers stored yet is no markers, not an error", () => {
  expect(readMarkers(ROUND)).toEqual({});
});

test("markers written are markers read back", () => {
  writeMarkers(ROUND, { [WANDA]: { x: 0.54, y: 0.05 } });
  expect(readMarkers(ROUND)).toEqual({ [WANDA]: { x: 0.54, y: 0.05 } });
});

test("another round's markers are not this round's markers", () => {
  writeMarkers(ROUND, { [WANDA]: { x: 0.54, y: 0.05 } });
  expect(readMarkers("a different round")).toEqual({});
});

test("a Marker at the very edge of the picture is kept, not clamped away", () => {
  writeMarkers(ROUND, { [WANDA]: { x: 0, y: 1 } });
  expect(readMarkers(ROUND)).toEqual({ [WANDA]: { x: 0, y: 1 } });
});

test("stored junk is refused rather than drawn on the picture", () => {

  // Not JSON at all, and JSON of the wrong shape: a Marker's point is the only
  // thing here that may reach the picture, so anything that is not one is gone.
  for (const junk of [
    "not json",
    "[]",
    '"a string"',
    "null",
    '{"Wanda": "somewhere"}',
    '{"Wanda": {"x": "left", "y": 0.5}}',
  ]) {
    store(junk);
    expect(readMarkers(ROUND), junk).toEqual({});
  }
});

test("a Marker outside the picture is dropped and a good one beside it survives", () => {
  store('{"Wanda": {"x": 1.4, "y": 0.5}, "Spike": {"x": 0.2, "y": 0.9}}');
  expect(readMarkers(ROUND)).toEqual({ Spike: { x: 0.2, y: 0.9 } });
});

