import { describe, expect, test } from "bun:test";
import { rememberReadingSpot, readingSpotForOpen, _noteTraversalForTests } from "../transcriptReadingSpot";

const spot = { messageUuid: "m1", timestamp: 1, offset: -40 };

describe("transcript reading spot", () => {
  test("a history step restores the remembered spot once", () => {
    rememberReadingSpot("a", spot);
    _noteTraversalForTests(1000);
    expect(readingSpotForOpen("a", 1500)).toEqual(spot);
    expect(readingSpotForOpen("a", 1600)).toBeNull();
  });

  test("an open long after the step is a fresh one: it lands on the tail", () => {
    rememberReadingSpot("a", spot);
    _noteTraversalForTests(1000);
    expect(readingSpotForOpen("a", 10_000)).toBeNull();
  });

  test("returning to the tail forgets the spot", () => {
    rememberReadingSpot("a", spot);
    rememberReadingSpot("a", null);
    _noteTraversalForTests(1000);
    expect(readingSpotForOpen("a", 1100)).toBeNull();
  });
});
