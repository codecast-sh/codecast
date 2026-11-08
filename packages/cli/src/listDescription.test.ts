import { describe, expect, test } from "bun:test";
import { listDescription } from "./commandSuggestion.js";

describe("listDescription", () => {
  test("a one-line description is kept as written", () => {
    expect(listDescription("Stop the background daemon")).toBe("Stop the background daemon");
  });

  test("only the first paragraph is kept", () => {
    const text = "Your machines and your team's\n\n  cast devices show <device>   one machine\n\nA device is an id prefix.";
    expect(listDescription(text)).toBe("Your machines and your team's");
  });

  test("a hard-wrapped first paragraph is joined into one line", () => {
    expect(listDescription("Hand this session's work to a new session, or\ngenerate a context transfer document\n\nMore."))
      .toBe("Hand this session's work to a new session, or generate a context transfer document");
  });

  test("a lead that introduces a list drops its colon", () => {
    expect(listDescription("Explore sessions, three ways:\n\n  --state  by work state")).toBe("Explore sessions, three ways");
  });

  test("a long first paragraph is cut to its first sentence", () => {
    const text = "Typecheck this tree through one shared tsc watcher per project. One watcher serves every\nsession on the tree and re-checks only what changed, so an ask takes seconds.";
    expect(listDescription(text)).toBe("Typecheck this tree through one shared tsc watcher per project.");
  });

  test("an abbreviation does not end the sentence", () => {
    const text = "Restart a session (e.g. jx7c6zk) or the daemon when the sync stalls and nothing else helps. Then wait for it to come back up and report.";
    expect(listDescription(text)).toBe("Restart a session (e.g. jx7c6zk) or the daemon when the sync stalls and nothing else helps.");
  });
});
