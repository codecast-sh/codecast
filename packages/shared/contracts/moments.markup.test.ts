import { expect, test } from "bun:test";
import { receivedWords, stripMomentMarkup } from "./moments";

test("an extractor's match tag, window marker and cut never read as words Union sent (tc-24, tc-25)", () => {
  expect(receivedWords("[About the match with Louis Stevens (match 1f3dc6ed)]")).toBe("");
  expect(receivedWords("[...truncated]")).toBe("");
  expect(receivedWords("[NEW, under judgment] [this match] Happy to set up a call Thursday at 3.")).toBe("Happy to set up a call Thursday at 3.");
  expect(stripMomentMarkup("[another match: Rafael Blanco (match acb0da81)] We're not going ahead. [… truncated]")).toBe("We're not going ahead.");
  expect(stripMomentMarkup("[On a thread linked on Oct 3 to the match with Kip; this message only inherits the link] Thanks!")).toBe("Thanks!");
});

test("brackets a person wrote stay", () => {
  expect(stripMomentMarkup("Fee is [TBD] for now")).toBe("Fee is [TBD] for now");
});
