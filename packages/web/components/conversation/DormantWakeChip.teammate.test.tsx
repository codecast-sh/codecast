// ct-101316: on a teammate's conversation the header's dormant-wake chip must
// not tell the viewer the session will be "yours" and return to Needs Input
// (it returns to its owner), and the chip must be something the viewer can press.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const realTriggers = { ...(await import("../../hooks/useSyncTriggers")) };
mock.module("../../hooks/useSyncTriggers", () => ({ ...realTriggers, useTriggers: () => ({ tasks: [], ready: true }) }));

const { useInboxStore, placeInboxRows } = await import("../../store/inboxStore");
const { declareViewNav } = await import("../../store/viewNav");
const { DormantWakeChip } = await import("./DormantWakeChip");

const ME = "k57me00000000000000000000000000a";
const OWNER = "k57owner000000000000000000000000";
const SID = "jd7teammate00000000000000000000a";
const now = Date.now();

const session = (user: string) => ({
  _id: SID, user_id: user, owner_user_id: user, title: "Teammate's session",
  agent_type: "claude_code", status: "active", agent_status: "idle",
  started_at: now - 3_600_000, updated_at: now - 60_000, last_message_at: now - 60_000,
  last_message_role: "assistant", message_count: 4, is_idle: true,
  thread_state: "waiting on a reply",
});

let prev: unknown;
beforeAll(() => { prev = useInboxStore.getState(); });
afterAll(() => { useInboxStore.setState(prev as never, true); });

function render(user: string) {
  useInboxStore.setState({ currentUser: { _id: ME } as never, sessions: { [SID]: session(user) } as never } as never);
  declareViewNav("gesture");
  useInboxStore.setState({ currentSessionId: SID } as never);
  const s = useInboxStore.getState();
  const bucket = placeInboxRows(s as never, { focusedId: SID, now }).placements.get(SID)?.bucket;
  console.log("DBG", s.currentSessionId, !!s.sessions[SID]);
  return { bucket, html: renderToStaticMarkup(<DormantWakeChip conversationId={SID} />) };
}

test("on a teammate's needs-input session the chip names the owner, not 'yours', and can be pressed", () => {
  const { bucket, html } = render(OWNER);
  // The setup the report describes: a needs-input session the viewer can't command.
  expect(bucket).toBe("needs_input");
  expect(html).not.toBe("");
  expect(html).not.toMatch(/\byours\b/);
  expect(html).not.toContain("It returns to Needs Input");
  expect(html).toMatch(/^<button\b/);
});
