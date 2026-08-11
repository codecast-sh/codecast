import { describe, expect, test } from "bun:test";
import { isHarnessEmittedUserTurn } from "./daemon.js";

// The positional delivery-ack pairing in syncMessagesBatch vouches user turns
// from a synced batch as echoes of rows this daemon pasted. Harness-emitted
// user turns — the boot <task-notification> bundle about background tasks from
// the previous session — are never paste echoes, and pairing one stamps the
// pending row's client_id onto the wrong transcript message. The real echo
// then re-adopts the same client_id by content match, leaving two messages
// with one client id (the web renders that as overlapping duplicate rows).
describe("isHarnessEmittedUserTurn", () => {
  test("recognizes a boot task-notification bundle", () => {
    const content =
      "<task-notification>\n<task-id>bufafc02i</task-id>\n<status>stopped</status>\n" +
      "<summary>No completion record was found for this background shell command from the previous session.</summary>\n" +
      "</task-notification>";
    expect(isHarnessEmittedUserTurn(content)).toBe(true);
  });

  test("tolerates leading whitespace", () => {
    expect(isHarnessEmittedUserTurn("  \n<task-notification>x</task-notification>")).toBe(true);
  });

  test("a real user message is not harness-emitted", () => {
    expect(isHarnessEmittedUserTurn("continue")).toBe(false);
    expect(isHarnessEmittedUserTurn("look at <task-notification> handling")).toBe(false);
  });

  test("empty and missing content are not harness-emitted", () => {
    expect(isHarnessEmittedUserTurn("")).toBe(false);
    expect(isHarnessEmittedUserTurn(undefined)).toBe(false);
  });
});
