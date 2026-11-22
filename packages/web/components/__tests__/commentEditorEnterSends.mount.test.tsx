// ct-97962: sending a quote with a note took two presses even when the
// composer was empty: Enter in the note editor only saved the note, and Send
// was a second action. With nothing typed in the composer, Enter in the note
// should save the note AND press the composer's send (the review bridge's
// attached `send`), once; with text in the composer it only saves.
//
// The composer's text is stated the way the store holds it: the conversation's
// draft (`drafts[id].draft_message`), absent for an empty composer.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { CommentEditor } = await import("../MessageReview");
const { ReviewComposerContext } = await import("../reviewContext");
const { createReviewComment } = await import("../../lib/reviewActions");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV = "conv_ct97962";

async function pressEnterInNote(composerText: string | null) {
  const s = useInboxStore.getState();
  s.clearReviewComments(CONV);
  if (composerText) s.setDraft(CONV, { draft_message: composerText });
  else s.clearDraftFinal(CONV);
  const id = createReviewComment(CONV, "msg_1", 0, "The quoted paragraph.");
  const comment = useInboxStore.getState().getReviewComments(CONV).find((c) => c.id === id)!;

  const sends: Array<{ body: string | undefined }> = [];
  const bridge = {
    quote: () => {},
    submit: () => {},
    conversationId: CONV,
    canSend: true,
    // What the composer's send takes: the batch as it stands when pressed.
    send: () => { sends.push({ body: useInboxStore.getState().getReviewComments(CONV).find((c) => c.id === id)?.body }); },
    attachSend: () => {},
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(
      <ReviewComposerContext.Provider value={bridge}>
        <CommentEditor conversationId={CONV} comment={comment} author={null} onDone={() => {}} />
      </ReviewComposerContext.Provider>,
    ));
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "my note");
      ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(() => { ta.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    const saved = useInboxStore.getState().getReviewComments(CONV).find((c) => c.id === id)?.body;
    return { sends, saved, draft: useInboxStore.getState().drafts[CONV]?.draft_message };
  } finally {
    await act(() => root.unmount());
    container.remove();
    useInboxStore.getState().clearReviewComments(CONV);
    useInboxStore.getState().clearDraftFinal(CONV);
  }
}

test("empty composer: Enter in the note saves the note and sends once, with the note in the batch", async () => {
  const { sends } = await pressEnterInNote(null);
  expect(sends).toEqual([{ body: "my note" }]);
});

test("composer has typed text: Enter in the note only saves, and sends nothing", async () => {
  const { sends, saved, draft } = await pressEnterInNote("half a reply");
  expect(saved).toBe("my note");
  expect(sends).toEqual([]);
  expect(draft).toBe("half a reply");
});
