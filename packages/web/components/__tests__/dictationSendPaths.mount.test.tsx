import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { flush, freshDictationHarness, mountComposer, sayTo, type FakeHost } from "./fixtures/dictationComposer";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { dictationRunning } from "@codecast/shared/contracts/dictation";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { ReviewComposerContext } from "../reviewContext";

// Every way the session composer sends waits for a recording's last words,
// the way Send and Enter do: Send and stash, Fork and send, Hand off and the
// review panel's send. Pressed mid-recording, none of them sends half the
// sentence. And a composer reused for another conversation never sends that
// one's draft for an Enter pressed in the old one.
// Run: bun test components/__tests__/dictationSendPaths.mount.test.tsx

// Hand off, with the roster and the picker stood in: the composer's part is
// what text it hands over and when.
const handedOff: Array<{ to: string; note: string; running: boolean }> = [];
const realOwners = { ...(await import("../OwnersBadge")) };
mock.module("../OwnersBadge", () => ({
  ...realOwners,
  useOwnersFromStore: () => ({
    currentUser: { _id: "user_dictation_test", name: "Tester" },
    canManage: true,
    handoffTo: async (to: string, note: string) => {
      handedOff.push({ to, note, running: dictationRunning() });
      return true;
    },
  }),
  HandoffPicker: ({ children, onPick }: { children: React.ReactNode; onPick: (t: { id: string; name: string }, keepSelf: boolean) => void }) => (
    <>
      {children}
      <button type="button" aria-label="Pick Ada" onClick={() => onPick({ id: "user_ada", name: "Ada" }, false)} />
    </>
  ),
}));

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const SESSION = "jx7dictationsendpaths00000000000"; // 32 chars: a real session id
const FORK = "fork_stub_dictation";

let host: FakeHost;
beforeEach(() => {
  host = freshDictationHarness();
  handedOff.length = 0;
});
afterEach(() => {
  delete w.__dictationTestHost;
});
const say = sayTo(() => host);

/** The words of a send, as the composer put them in the conversation. */
const pendingText = (id: string) => (useInboxStore.getState().pendingMessages[id] ?? []).map((m: any) => m.content);

/** Dictate "please fix the login", then (mid-recording) do `press`; the last
 *  word arrives after the press. */
async function pressMidRecording(c: Awaited<ReturnType<typeof mountComposer>>, press: () => Promise<void>) {
  await c.press("Dictate");
  await say((e) => e.onUtterance({ text: "please fix" }));
  await say((e) => e.onPartial("the login"));
  await press();
  // Nothing went out with half the sentence, and the recording is finishing,
  // not ended by the box emptying under it.
  expect(dictationRunning()).toBe(true);
  expect(host.finishing).toBe(true);
  expect(c.textarea().value).toBe("please fix the login");
  await say((e) => e.onUtterance({ text: "the login bug." }));
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
}

test("Send and stash mid-recording sends the whole sentence, then stashes", async () => {
  let dismissed = 0;
  const c = await mountComposer({ props: { onGateSend: undefined, conversationId: SESSION, onSendAndDismiss: () => { dismissed++; } } });
  await pressMidRecording(c, async () => {
    await c.press("Send and stash");
    expect(pendingText(c.draftKey)).toEqual([]);
    expect(dismissed).toBe(0);
  });
  expect(pendingText(c.draftKey)).toEqual(["please fix the login bug."]);
  expect(dismissed).toBe(1);
  expect(c.textarea().value).toBe("");
  await c.unmount();
});

test("Fork and send mid-recording forks once the last words are in, with them", async () => {
  const forkedWhile: boolean[] = [];
  const c = await mountComposer({ props: { onGateSend: undefined, onForkTail: async () => { forkedWhile.push(dictationRunning()); return FORK; } } });
  await pressMidRecording(c, async () => {
    await c.press("Fork and send");
    expect(forkedWhile).toEqual([]);
  });
  expect(forkedWhile).toEqual([false]);
  expect(pendingText(FORK)).toEqual(["please fix the login bug."]);
  expect(pendingText(c.draftKey)).toEqual([]);
  await c.unmount();
});

test("Hand off mid-recording hands over the whole sentence as the note", async () => {
  const c = await mountComposer({ props: { onGateSend: undefined, conversationId: SESSION } });
  await pressMidRecording(c, async () => {
    await c.press("Pick Ada");
    expect(handedOff).toEqual([]);
  });
  expect(handedOff).toEqual([{ to: "user_ada", note: "please fix the login bug.", running: false }]);
  expect(c.textarea().value).toBe("");
  await c.unmount();
});

test("the review panel's send mid-recording sends the whole sentence", async () => {
  let reviewSend: (() => void) | null = null;
  const review = { quote: () => {}, submit: () => {}, conversationId: SESSION, attachSend: (send: (() => void) | null) => { reviewSend = send; } };
  const c = await mountComposer({
    props: { conversationId: SESSION },
    wrap: (composer) => <ReviewComposerContext.Provider value={review}>{composer}</ReviewComposerContext.Provider>,
  });
  await pressMidRecording(c, async () => {
    await act(async () => { reviewSend!(); });
    await flush();
    expect(c.sent).toEqual([]);
  });
  expect(c.sent).toEqual(["please fix the login bug."]);
  await c.unmount();
});

test("a composer switched to another conversation while finishing sends nothing there, and the old draft keeps its words", async () => {
  const OTHER = "chat-draft:dictation-other";
  const c = await mountComposer();
  useInboxStore.getState().setDraft(OTHER, { draft_message: "the other draft" } as any);
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  await say((e) => e.onUtterance({ text: "please fix the login." }));
  await c.key("Enter");
  expect(host.finishing).toBe(true);
  await c.switchTo(OTHER);
  await act(async () => { host.endFinish!(); });
  await flush();
  await flush();
  expect(dictationRunning()).toBe(false);
  expect(c.sent).toEqual([]);
  expect(c.textarea().value).toBe("the other draft");
  await c.switchTo(c.draftKey);
  expect(c.textarea().value).toBe("please fix the login.");
  await c.unmount();
});

test("a switch while recording, with no send waiting, keeps the words and stops at once", async () => {
  const c = await mountComposer();
  await c.press("Dictate");
  await say((e) => e.onUtterance({ text: "half a thought" }));
  await c.switchTo("chat-draft:dictation-elsewhere");
  // Let go, not finished: no last words are waited for, since they would land here.
  expect(host.finishing).toBe(false);
  expect(host.closed).toBe(1);
  expect(dictationRunning()).toBe(false);
  expect(c.sent).toEqual([]);
  await c.switchTo(c.draftKey);
  expect(c.textarea().value).toBe("half a thought");
  await c.unmount();
});

test("a switch before the first words: words arriving after it never reach the new conversation, and Enter there sends nothing", async () => {
  // Both drafts empty, so the box looks the same to the recording before and after.
  const OTHER = "chat-draft:dictation-other-empty";
  const c = await mountComposer();
  await act(async () => { c.textarea().focus(); });
  await c.press("Dictate");
  expect(c.button("Cancel dictation")).not.toBeNull();
  await c.switchTo(OTHER);
  // The recognizer was still on its way with words meant for the old conversation.
  await say((e) => e.onUtterance({ text: "words meant for A" }));
  await say((e) => e.onPartial("and more for A"));
  expect(c.textarea().value).toBe("");
  expect(useInboxStore.getState().drafts[OTHER]?.draft_message ?? "").toBe("");
  await c.key("Enter");
  // Any last-words wait the recognizer still held ends here.
  await act(async () => { host.endFinish?.(); });
  await flush();
  expect(c.sent).toEqual([]);
  expect(c.textarea().value).toBe("");
  // It let go at the switch: closed, not finished.
  expect(host.finishing).toBe(false);
  expect(host.closed).toBe(1);
  expect(dictationRunning()).toBe(false);
  expect(c.button("Dictate")).not.toBeNull();
  await c.unmount();
});
