import { expect, test } from "bun:test";
import { headCaption } from "./orgMeta";

test("the Head of People's caption is its charter's first sentence, else the job every Head of People has", () => {
  expect(headCaption({ charter: "Keeps every project led and every goal owned. Reviews weekly." })).toBe("Keeps every project led and every goal owned");
  expect(headCaption({ charter: "\n# Reads the room\nMore." })).toBe("Reads the room");
  expect(headCaption({ charter: "  " })).toBe("Reads the company and proposes who does what");
  expect(headCaption({})).toBe("Reads the company and proposes who does what");
  // The standing prompt speaks to the agent, and a long first sentence would be cut: neither reaches the founder.
  expect(headCaption({ charter: "Your job is to keep the company's structure true to how the work runs." })).toBe("Reads the company and proposes who does what");
  expect(headCaption({ charter: "You read the company." })).toBe("Reads the company and proposes who does what");
  expect(headCaption({ charter: `Keeps ${"every project and every goal ".repeat(4)}in order.` })).toBe("Reads the company and proposes who does what");
});
