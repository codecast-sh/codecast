import { describe, expect, test } from "bun:test";
import { noticeWords, offersRoutine, ROUTINE_OFFER } from "./HostedNotice";

describe("a stop notice's words", () => {
  test("beside a button, the invitation to ask again goes", () => {
    expect(noticeWords("I stopped here. You can ask me to try again.", 0, true)).toBe("I stopped here.");
    expect(noticeWords("I stopped here. You can ask me to try again.", 0, false)).toBe("I stopped here. You can ask me to try again.");
  });

  test("a repeated stop is one line with the count", () => {
    expect(noticeWords("Something went wrong on my side.", 1, true)).toBe("Still can't get through after 2 tries.");
  });
});

describe("the routine offer under a first answer", () => {
  test("offered after a first finished answer that is not a question", () => {
    expect(offersRoutine("Here are three vacuums.", "Compare robot vacuums", 1, false)).toBe(true);
    expect(ROUTINE_OFFER.label).toBe("Want this every week?");
  });

  test("not while working, after a second turn, on a question back, or when the ask was already a schedule", () => {
    expect(offersRoutine("Here.", "Compare", 1, true)).toBe(false);
    expect(offersRoutine("Here.", "Compare", 2, false)).toBe(false);
    expect(offersRoutine("Which size is your apartment?", "Compare", 1, false)).toBe(false);
    expect(offersRoutine("Done.", "Every Monday at 9, remind me", 1, false)).toBe(false);
  });
});
