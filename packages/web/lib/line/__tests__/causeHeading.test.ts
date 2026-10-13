import { describe, expect, test } from "bun:test";
import { causeHeading } from "../causeHeading";

describe("causeHeading", () => {
  test("labels that agree read whole", () => {
    expect(causeHeading(["Its session never started at Prove", "Its session never started at Prove"])).toBe("Its session never started at Prove");
  });
  test("a detail that differs drops to the clause they share, keeping the step", () => {
    expect(causeHeading(["Out of time, 1.5h at Implement", "Out of time, 3h at Implement"])).toBe("Out of time at Implement");
    expect(causeHeading(["Prove blocked: Miss reproduced on base, but X", "Prove blocked: the gate is red"])).toBe("Prove blocked");
  });
  test("only leading words shared: the step stopped", () => {
    expect(causeHeading(["Implement blocked: Call-script fix", "Implement ended without a report"])).toBe("Implement stopped");
  });
  test("nothing shared reads the first label's clause", () => {
    expect(causeHeading(["Stopped by hand", "Runner shut down"])).toBe("Stopped by hand");
  });
});

test("a shared first letter is no shared word", () => {
  expect(causeHeading(["Ran out", "Refused"])).toBe("Ran out");
});
