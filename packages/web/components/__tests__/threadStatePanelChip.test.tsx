import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadStatePanelView } from "../ThreadStatePanel";

// The panel above the composer names the status the sidebar files the session
// under. A pin a later turn left behind ("Sleeping" on a session under Needs
// You, jx75e8s) shows where the session files, never the pin's claim and never
// nothing.

const NOW = 1_800_000_000_000;
const noop = () => {};

function panel(threadStateStatus: string, placed?: "blocked" | "dormant" | "done" | "working" | null): string {
  return renderToStaticMarkup(
    <ThreadStatePanelView
      conversationId="c1"
      threadState={"Waiting on typecheck\nNext: read the typecheck, then report"}
      threadStateAt={NOW - 4 * 60_000}
      threadStateMsgCount={160}
      threadStateStatus={threadStateStatus}
      placed={placed}
      messageCount={170}
      now={NOW}
      collapsed={false}
      prStatus={null}
      onToggle={noop}
    />,
  );
}

describe("ThreadStatePanelView: the chip names where the inbox files the session", () => {
  test("a dormant pin on a session under Needs You reads Needs you", () => {
    const html = panel("dormant", "blocked");
    expect(html).toContain("Needs you");
    expect(html).not.toContain("Sleeping");
  });

  test("a pin the inbox agrees with keeps its own status", () => {
    expect(panel("dormant", "dormant")).toContain("Sleeping");
  });

  test("with no placement known, the pin speaks for itself", () => {
    expect(panel("dormant")).toContain("Sleeping");
  });

  test("a row the inbox files under no status reads as a plain pin", () => {
    const html = panel("dormant", null);
    expect(html).not.toContain("Sleeping");
    expect(html).toContain("Pinned");
  });
});
