import { describe, expect, test } from "bun:test";
import { lastTurns } from "../../lib/lastTurns";

describe("lastTurns", () => {
  test("shows the newest ask and the agent's newest words after it, skipping tool rows and framing", () => {
    const rows = [
      { _id: "1", role: "user", content: "first ask" },
      { _id: "2", role: "user", content: "fix the **deploy** script" },
      { _id: "3", role: "assistant", content: "Looking at it." },
      { _id: "4", role: "user", content: "", tool_results: [{}] },
      { _id: "5", role: "assistant", content: "Fixed it in `deploy.sh`." },
      { _id: "6", role: "user", content: "<system-reminder>noise</system-reminder>" },
      { _id: "7", role: "system", content: "switched model" },
    ];
    expect(lastTurns(rows)).toEqual([
      { _id: "2", role: "user", text: "fix the deploy script" },
      { _id: "5", role: "assistant", text: "Fixed it in deploy.sh." },
    ]);
  });

  test("when the person spoke last, pairs the ask with the agent's words before it", () => {
    const rows = [
      { _id: "1", role: "assistant", content: "Done." },
      { _id: "2", role: "user", content: "now polish it" },
    ];
    expect(lastTurns(rows).map((t) => t._id)).toEqual(["1", "2"]);
  });

  test("with no ask in reach, the last two turns", () => {
    const rows = [
      { _id: "1", role: "assistant", content: "a" },
      { _id: "2", role: "assistant", content: "b" },
      { _id: "3", role: "assistant", content: "c" },
    ];
    expect(lastTurns(rows).map((t) => t._id)).toEqual(["2", "3"]);
  });
});

describe("lastTurns envelopes", () => {
  test("a message from another session shows its body under the sender's name", () => {
    const rows = [
      { _id: "1", role: "user", content: '<session-message from="jx7d538" name="Cam">\nrelay both in one wake\n</session-message>' },
      { _id: "2", role: "assistant", content: "Relayed." },
    ];
    expect(lastTurns(rows)[0]).toEqual({ _id: "1", role: "user", text: "relay both in one wake", from: "Cam" });
  });
});
