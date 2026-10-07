import { describe, expect, test } from "bun:test";
import { noticeWords, routineOffer } from "./HostedNotice";

describe("a stop notice's words", () => {
  test("beside a button, the invitation to ask again goes", () => {
    expect(noticeWords("I stopped here. You can ask me to try again.", 0, true)).toBe("I stopped here.");
    expect(noticeWords("I stopped here. You can ask me to try again.", 0, false)).toBe("I stopped here. You can ask me to try again.");
  });

  test("a repeated stop keeps the count and one short reason", () => {
    expect(noticeWords("Something went wrong on my side.", 1, true)).toBe("Still can't get through after 2 tries. The trouble is on our side, not yours.");
  });
});

describe("the routine offer under a first answer", () => {
  test("offered for an errand that repeats, worded with its cadence", () => {
    expect(routineOffer("Here is today's news.", "Give me a summary of the tech news", 1, false)).toEqual({ label: "Do this every morning?", ask: "Do this for me every morning." });
    expect(routineOffer("Here is a checklist.", "Help me plan the week", 1, false)?.label).toBe("Do this every Monday?");
    expect(routineOffer("They are $199 now.", "Check the prices of these headphones", 1, false)?.label).toBe("Do this every week?");
  });

  test("never for a one-off errand: a note, a comparison, a trip", () => {
    expect(routineOffer("Here are three vacuums.", "Compare the three best rated robot vacuums", 1, false)).toBeNull();
    expect(routineOffer("Here is a note.", "Help me write a kind note saying no to an invitation", 1, false)).toBeNull();
    expect(routineOffer("Here is a plan.", "Plan a relaxed weekend away for two, with a rough budget", 1, false)).toBeNull();
    // A list inside a one-off errand, or an errand tied to a date, is done once.
    expect(routineOffer("Here it is.", "Make a packing list for a 3-day camping trip in October, with a short checklist for the night before", 1, false)).toBeNull();
    expect(routineOffer("Here they are.", "Check the prices of flights for my trip tomorrow", 1, false)).toBeNull();
    expect(routineOffer("Here they are.", "Add these to my to-dos", 1, false)).toBeNull();
  });

  test("not while working, after a second turn, on a question anywhere in the last paragraph, or when the ask was already a schedule", () => {
    expect(routineOffer("Here.", "Summarize the news", 1, true)).toBeNull();
    expect(routineOffer("Here.", "Summarize the news", 2, false)).toBeNull();
    expect(routineOffer("Which topics do you follow?", "Summarize the news", 1, false)).toBeNull();
    expect(routineOffer("Here are the headlines.\n\nWhich one appeals to you? I'll dig into it next.", "Summarize the news", 1, false)).toBeNull();
    expect(routineOffer("Done.", "Every Monday at 9, remind me", 1, false)).toBeNull();
  });
});
