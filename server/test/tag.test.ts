import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTag } from "../src/tag.ts";

describe("parseTag", () => {
  it("takes the tag as written", () => {
    assert.equal(parseTag("Waldo Fan"), "Waldo Fan");
  });

  it("trims the spaces a keyboard leaves behind", () => {
    assert.equal(parseTag("  Ada \n"), "Ada");
  });

  it("refuses a tag of nothing but spaces", () => {
    assert.equal(parseTag("   "), null);
  });

  it("refuses a tag longer than a leaderboard row can show", () => {
    assert.equal(parseTag("a".repeat(17)), null);
  });

  it("accepts a tag of exactly sixteen characters", () => {
    assert.equal(parseTag("a".repeat(16)), "a".repeat(16));
  });

  it("refuses a tag that is not text at all", () => {
    assert.equal(parseTag(42), null);
    assert.equal(parseTag(null), null);
    assert.equal(parseTag({ toString: () => "Ada" }), null);
  });

  it("counts the trimmed length, not the length typed", () => {
    assert.equal(parseTag(`  ${"a".repeat(16)}  `), "a".repeat(16));
  });
});