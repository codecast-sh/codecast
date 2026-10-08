import { expect, test } from "bun:test";
import { headCaption } from "./OrgConversation";

test("the Head of People's caption is its charter's first sentence, else the job every Head of People has", () => {
  expect(headCaption({ charter: "Keeps every project led and every goal owned. Reviews weekly." })).toBe("Keeps every project led and every goal owned");
  expect(headCaption({ charter: "\n# Reads the room\nMore." })).toBe("Reads the room");
  expect(headCaption({ charter: "  " })).toBe("Reads the company and proposes who does what");
  expect(headCaption({})).toBe("Reads the company and proposes who does what");
});
