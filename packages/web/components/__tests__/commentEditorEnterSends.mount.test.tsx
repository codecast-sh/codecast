// ct-97962: sending a quote with a note took two presses even when the
// composer was empty: Enter in the note editor only saved the note, and Send
// was a second action. With nothing typed in the composer, Enter in the note
// should save the note AND press the composer's send (the review bridge's
// attached `send`), once; with text in the composer it only saves.
//
// The composer's text is stated the way the store holds it: the conversation's
// draft (`drafts[id].draft_message`, and `draft_image_storage_ids` for pasted
// images), absent for an empty composer. The note's primary button says what
// Enter will do: "Send" when it sends, "Save" when it only saves.
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

type Composer = { text?: string; images?: number };

async function pressInNote(composer: Composer | null, how: "enter" | "click" = "enter") {
  const s = useInboxStore.getState();
  s.clearReviewComments(CONV);
  if (composer) s.setDraft(CONV, {
    draft_message: composer.text ?? null,
    draft_image_storage_ids: composer.images ? Array.from({ length: composer.images }, (_, i) => ({ storageId: `st_${i}`, previewUrl: `blob:${i}` })) : null,
  });
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
    const primary = container.querySelector(".cc-comment-btn-primary") as HTMLButtonElement;
    const label = primary.firstChild?.textContent;
    if (how === "enter") await act(() => { ta.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    else await act(() => { primary.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    const saved = useInboxStore.getState().getReviewComments(CONV).find((c) => c.id === id)?.body;
    const d = useInboxStore.getState().drafts[CONV];
    return { sends, saved, label, draft: d?.draft_message, images: d?.draft_image_storage_ids?.length ?? 0 };
  } finally {
    await act(() => root.unmount());
    container.remove();
    useInboxStore.getState().clearReviewComments(CONV);
    useInboxStore.getState().clearDraftFinal(CONV);
  }
}

test("empty composer: Enter in the note saves the note and sends once, with the note in the batch", async () => {
  const { sends, label } = await pressInNote(null);
  expect(label).toBe("Send");
  expect(sends).toEqual([{ body: "my note" }]);
});

test("empty composer: the Send button does what Enter does", async () => {
  const { sends } = await pressInNote(null, "click");
  expect(sends).toEqual([{ body: "my note" }]);
});

test("composer has typed text: Enter in the note only saves, and sends nothing", async () => {
  const { sends, saved, draft, label } = await pressInNote({ text: "half a reply" });
  expect(label).toBe("Save");
  expect(saved).toBe("my note");
  expect(sends).toEqual([]);
  expect(draft).toBe("half a reply");
});

test("composer holds only an image: Enter in the note only saves, and the image stays", async () => {
  const { sends, saved, images, label } = await pressInNote({ images: 1 });
  expect(label).toBe("Save");
  expect(saved).toBe("my note");
  expect(sends).toEqual([]);
  expect(images).toBe(1);
});
