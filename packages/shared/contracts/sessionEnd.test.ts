import { expect, test } from "bun:test";
import { sessionEndWords } from "./sessionEnd";

test("a session's end reads in words wherever a stop quotes its station's output", () => {
  expect(sessionEndWords("Stopped: The reviewer left no verdict, so the change is not judged. work_state: needs_input"))
    .toBe("Stopped: The reviewer left no verdict, so the change is not judged. Its session stopped, waiting for input.");
  expect(sessionEndWords("work_state: done\nReviewed: ship")).toBe("Its session finished.\nReviewed: ship");
  expect(sessionEndWords("work_state: thinking_hard")).toBe("Its session read thinking hard.");
  // Text that only mentions the field, inside other words, stays.
  expect(sessionEndWords("the row's work_state:done field")).toBe("the row's work_state:done field");
});
