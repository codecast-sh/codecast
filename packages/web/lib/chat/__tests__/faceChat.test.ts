import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  __resetFaceChat,
  clearFaceUnseen,
  deliverChatToFace,
  faceBubbleFailed,
  faceBubbleShown,
  getFaceChat,
  holdFaceBubble,
  openFacePanel,
  registerFaceChatLayer,
  releaseFaceBubble,
  type FaceArrival,
} from "../faceChat";

let seq = 0;
const line = (text: string, over: Partial<FaceArrival> = {}): FaceArrival => ({
  messageId: `m${++seq}`,
  channelId: "c-team",
  channelName: "team",
  isDm: false,
  preview: text,
  at: Date.now(),
  loud: false,
  count: 1,
  ...over,
});
const unseen = (id: string) => (getFaceChat().unseen[id] ?? []).map((a) => a.preview);
/** The header found the face: the bubble starts its clock. */
const show = () => {
  const b = getFaceChat().bubble;
  if (b?.phase === "wait") faceBubbleShown(b.key);
};

describe("chat from the face", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetFaceChat();
    registerFaceChatLayer({ canShow: (id) => id !== "agent" });
  });
  afterEach(() => jest.useRealTimers());

  test("a line drops from the face, then folds back into a count on it", () => {
    expect(deliverChatToFace("sam", line("gimme a bit longer"), () => {})).toBe(true);
    expect(getFaceChat().bubble?.phase).toBe("wait");
    show();
    expect(getFaceChat().bubble?.phase).toBe("in");
    expect(unseen("sam")).toEqual([]);
    jest.advanceTimersByTime(10_000);
    expect(getFaceChat().bubble).toBeNull();
    expect(unseen("sam")).toEqual(["gimme a bit longer"]);
  });

  test("looking at the face clears its count", () => {
    deliverChatToFace("sam", line("gimme a bit longer"), () => {});
    show();
    jest.advanceTimersByTime(10_000);
    expect(unseen("sam")).toEqual(["gimme a bit longer"]);
    clearFaceUnseen("sam");
    expect(unseen("sam")).toEqual([]);
  });

  test("a face the header cannot show is refused, so the caller toasts", () => {
    expect(deliverChatToFace("agent", line("deploy done"), () => {})).toBe(false);
    expect(getFaceChat().bubble).toBeNull();
  });

  test("the same person typing again stacks into the open bubble", () => {
    deliverChatToFace("sam", line("ok found it"), () => {});
    show();
    deliverChatToFace("sam", line("it was the gain"), () => {});
    expect(getFaceChat().bubble?.items.map((a) => a.preview)).toEqual(["ok found it", "it was the gain"]);
  });

  test("a burst shows one bubble, a mention wins the next, everyone else is badged", () => {
    deliverChatToFace("sam", line("first"), () => {});
    show();
    deliverChatToFace("cam", line("room chatter"), () => {});
    deliverChatToFace("maya", line("@you look at this", { loud: true }), () => {});
    deliverChatToFace("jules", line("lunch?"), () => {});
    // The first bubble gets its fair minimum, not its full dwell.
    jest.advanceTimersByTime(1_700);
    jest.advanceTimersByTime(800);
    const b = getFaceChat().bubble;
    expect(b?.authorId).toBe("maya");
    expect(unseen("sam")).toEqual(["first"]);
    expect(unseen("cam")).toEqual(["room chatter"]);
    expect(unseen("jules")).toEqual(["lunch?"]);
  });

  test("holding the bubble keeps it; letting go lets it fold", () => {
    deliverChatToFace("sam", line("hold me"), () => {});
    show();
    holdFaceBubble();
    jest.advanceTimersByTime(60_000);
    expect(getFaceChat().bubble?.phase).toBe("in");
    releaseFaceBubble();
    jest.advanceTimersByTime(2_000);
    expect(getFaceChat().bubble).toBeNull();
    expect(unseen("sam")).toEqual(["hold me"]);
  });

  test("opening the panel clears the count and remembers what was new", () => {
    deliverChatToFace("sam", line("one"), () => {});
    show();
    jest.advanceTimersByTime(10_000);
    const [{ messageId }] = getFaceChat().unseen.sam!;
    openFacePanel("sam");
    expect(unseen("sam")).toEqual([]);
    expect(getFaceChat().panel).toEqual({ authorId: "sam", unreadIds: [messageId], focus: true });
    // While their panel is open, their next line lands there as unread, not in a bubble.
    deliverChatToFace("sam", line("two"), () => {});
    expect(getFaceChat().bubble).toBeNull();
    expect(getFaceChat().panel?.unreadIds).toHaveLength(2);
    // Someone else speaking does not interrupt the reader: a count only.
    deliverChatToFace("cam", line("hey"), () => {});
    expect(getFaceChat().bubble).toBeNull();
    expect(unseen("cam")).toEqual(["hey"]);
  });

  test("a face that never turns up sends its lines out as toasts", () => {
    let toasted = 0;
    deliverChatToFace("sam", line("lost"), () => toasted++);
    faceBubbleFailed(getFaceChat().bubble!.key);
    expect(toasted).toBe(1);
    expect(getFaceChat().bubble).toBeNull();
    expect(unseen("sam")).toEqual([]);
  });
});
