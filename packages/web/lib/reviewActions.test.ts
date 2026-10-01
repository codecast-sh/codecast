import { test, expect, describe, beforeEach } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { takeReviewBatch, attachReviewToMessage, createReviewComment, addImagePin, quotedImageStorageIds } from "./reviewActions";
import { formatPlanFeedback, formatDocFeedback, formatPendingComments, sortPendingComments, type PendingComment } from "./quoteFormat";

const CONV = "conv-test";

const mk = (id: string, blockIndex: number, quote: string, body: string): PendingComment => ({
  id,
  messageId: "m1",
  blockIndex,
  quote,
  body,
  createdAt: blockIndex,
});

function seed(comments: PendingComment[]) {
  useInboxStore.setState({
    reviewComments: comments.length ? { [CONV]: comments } : {},
    reviewMessageId: "m1",
    reviewEditingId: "edit-1",
  } as any);
}

beforeEach(() => {
  useInboxStore.setState({ reviewComments: {}, reviewMessageId: null, reviewEditingId: null } as any);
});

describe("takeReviewBatch", () => {
  test("compiles quotes + notes into markdown and clears the batch + review state", () => {
    seed([mk("1", 0, "q1", "n1"), mk("2", 1, "q2", "")]);
    expect(takeReviewBatch(CONV)).toBe("> q1\n\nn1\n\n> q2");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]).toBeUndefined();
    expect(s.reviewMessageId).toBeNull();
    expect(s.reviewEditingId).toBeNull();
  });

  test("returns empty string when nothing meaningful is pending", () => {
    seed([]);
    expect(takeReviewBatch(CONV)).toBe("");
  });

  test("scoped to a messageId takes only those comments and clears just them (plan review)", () => {
    // Plan comments live under a namespaced key; an unrelated body comment must survive.
    seed([
      { id: "p1", messageId: "m1#plan", blockIndex: 0, quote: "plan line", body: "wrong", createdAt: 0 },
      { id: "b1", messageId: "m1", blockIndex: 0, quote: "body line", body: "", createdAt: 1 },
    ]);
    expect(takeReviewBatch(CONV, "m1#plan")).toBe("> plan line\n\nwrong");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]?.map((c) => c.id)).toEqual(["b1"]); // body comment untouched
  });
});

describe("formatPlanFeedback", () => {
  test("wraps the annotation batch in directive rejection framing", () => {
    const out = formatPlanFeedback("> bad section\n\nfix this");
    expect(out).toContain("The plan was NOT approved");
    expect(out).toContain("Do not re-present the same plan unchanged");
    expect(out.endsWith("> bad section\n\nfix this")).toBe(true);
  });

  test("falls back to a generic request when the batch is empty", () => {
    expect(formatPlanFeedback("")).toContain("Plan changes requested.");
  });
});

describe("diff line comments ride the shared batch out to the agent", () => {
  test("a line comment becomes a file:line blockquote + note on the next reply", () => {
    // Shape a DiffView line comment writes: messageId = the per-file diff anchor,
    // blockIndex = the line key, quote = "path:line\n<code>".
    useInboxStore.getState().addReviewComment(CONV, {
      id: "lc1",
      messageId: "diff:tool_7:packages/web/x.ts",
      blockIndex: 42,
      quote: "packages/web/x.ts:42\nconst y = bar()",
      body: "rename y — too vague",
      createdAt: 1,
    });
    expect(attachReviewToMessage(CONV, "")).toBe(
      "> packages/web/x.ts:42\n> const y = bar()\n\nrename y — too vague",
    );
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined(); // consumed
  });
});

describe("formatDocFeedback", () => {
  const batch = formatPendingComments(
    sortPendingComments([
      { id: "1", messageId: "doc:d1", blockIndex: 0, quote: "line one", body: "make this clearer", createdAt: 0 },
      { id: "2", messageId: "doc:d1", blockIndex: 1, quote: "line two", body: "", createdAt: 1 },
    ]),
  );

  test("names the doc, gives DB-edit instructions, and lists the annotations", () => {
    const out = formatDocFeedback("Spec", "d1", batch);
    expect(out).toContain('Feedback on document "Spec" (doc `d1`)');
    expect(out).toContain("cast doc edit d1");
    expect(out).toContain("> line one");
    expect(out).toContain("make this clearer");
    expect(out).toContain("> line two");
  });

  test("appends an optional cover note after the annotations", () => {
    const out = formatDocFeedback("Spec", "d1", batch, "overall: tighten the intro");
    expect(out.endsWith("overall: tighten the intro")).toBe(true);
  });

  test("falls back to a generic request when nothing was annotated", () => {
    expect(formatDocFeedback("Spec", "d1", "")).toContain("Changes requested.");
  });
});

describe("attachReviewToMessage", () => {
  test("prepends the batch to the typed reply", () => {
    seed([mk("1", 0, "q1", "")]);
    expect(attachReviewToMessage(CONV, "my reply")).toBe("> q1\n\nmy reply");
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined(); // consumed
  });

  test("sends the batch alone when nothing was typed", () => {
    seed([mk("1", 0, "q1", "note")]);
    expect(attachReviewToMessage(CONV, "")).toBe("> q1\n\nnote");
  });

  test("leaves the typed message untouched when no quotes are pending", () => {
    expect(attachReviewToMessage(CONV, "just text")).toBe("just text");
  });
});

describe("image quotes from the gallery", () => {
  const shot = { src: "https://x.convex.cloud/api/storage/s1", href: "https://x.convex.cloud/api/storage/s1", storageId: "s1", messageId: "m1" };
  const remote = { src: "https://example.com/a.png", href: "https://example.com/a.png", messageId: "m2" };

  beforeEach(() => {
    useInboxStore.setState({
      messages: {
        [CONV]: [
          { _id: "m1", role: "assistant", content: "Here is the dashboard after the fix", timestamp: 1_700_000_000_000 },
          { _id: "m1b", role: "assistant", content: "", timestamp: 1_700_000_050_000, tool_calls: [{ id: "tu1", name: "Read", input: JSON.stringify({ file_path: "/tmp/shot.png" }) }] },
          { _id: "m2", role: "user", content: "", timestamp: 1_700_000_100_000, images: [{ storage_id: "s2", tool_use_id: "tu1" }] },
        ],
      },
    } as any);
  });

  test("a pin joins the batch beside paragraph quotes and opens its note editor", () => {
    seed([mk("1", 0, "a paragraph", "")]);
    const id = addImagePin(CONV, { ...shot, width: 1600, height: 900 }, { x: 0.25, y: 0.5 });
    const pin = useInboxStore.getState().reviewComments[CONV].find((c) => c.id === id);
    expect(pin?.image).toEqual({ src: shot.src, href: shot.href, storageId: "s1", width: 1600, height: 900, point: { x: 0.25, y: 0.5 } });
    expect(pin?.messageId).toBe("m1");
    expect(pin?.quote).toStartWith("Image from your message at ");
    expect(pin?.quote).toEndWith(': "Here is the dashboard after the fix"');
    expect(useInboxStore.getState().reviewEditingId).toBe(id);
  });

  test("each pin names its picture's attachment number and the point in pixels; a picture pinned twice attaches once", () => {
    const a = addImagePin(CONV, { ...shot, width: 1600, height: 900 }, { x: 0.25, y: 0.5 });
    const b = addImagePin(CONV, { ...shot, width: 1600, height: 900 }, { x: 0.9, y: 0.1 });
    const c = addImagePin(CONV, remote, { x: 0.5, y: 0.5 });
    const s = useInboxStore.getState();
    s.commitReviewComment(CONV, a, "this button is misaligned");
    s.commitReviewComment(CONV, b, "and this badge overlaps");
    s.commitReviewComment(CONV, c, "wrong color");
    expect(quotedImageStorageIds(CONV)).toEqual(["s1"]);
    const text = attachReviewToMessage(CONV, "fix these", 3);
    const blocks = text.split("\n\n");
    expect(blocks[0]).toBe("> [Image 3] at x=400, y=450 of 1600×900 px (25% from the left, 50% from the top)\n> " + blocks[0].split("\n> ")[1]);
    expect(blocks[1]).toBe("this button is misaligned");
    expect(blocks[2]).toStartWith("> [Image 3] at x=1440, y=90 of 1600×900 px");
    expect(blocks[3]).toBe("and this badge overlaps");
    expect(blocks[4]).toMatch(/^> !\[image\]\(https:\/\/example\.com\/a\.png\) at 50% from the left, 50% from the top\n> Image returned by your Read call at .*: `\/tmp\/shot\.png`$/);
    expect(blocks[5]).toBe("wrong color");
    expect(blocks[6]).toBe("fix these");
  });

  test("without attachment numbers a pin points at the picture by address", () => {
    addImagePin(CONV, shot, { x: 0.1, y: 0.2 });
    expect(takeReviewBatch(CONV)).toStartWith(`> ![image](${shot.href}) at 10% from the left, 20% from the top\n> Image from your message`);
  });
});

describe("removeReviewComment clears the review target (no lingering highlight)", () => {
  const remove = (id: string) => useInboxStore.getState().removeReviewComment(CONV, id);

  test("removing the last quote drops reviewMessageId so the overlay stops painting", () => {
    seed([mk("1", 0, "q1", "")]);
    remove("1");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]).toBeUndefined();
    expect(s.reviewMessageId).toBeNull();
    expect(s.reviewActiveBlock).toBe(0);
    expect(s.reviewEditingId).toBeNull();
  });

  test("removing the last quote ON the target message clears the target even if other messages keep quotes", () => {
    // m1 = target (one quote), m2 = another message with its own quote.
    seed([mk("1", 0, "q1", ""), { id: "2", messageId: "m2", blockIndex: 0, quote: "q2", body: "", createdAt: 2 }]);
    remove("1");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]?.map((c) => c.id)).toEqual(["2"]); // m2's quote survives
    expect(s.reviewMessageId).toBeNull(); // target m1 had its last quote removed
  });

  test("removing a non-target quote keeps the target intact", () => {
    seed([mk("1", 0, "q1", ""), mk("2", 1, "q2", "")]); // both on m1
    remove("2");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]?.map((c) => c.id)).toEqual(["1"]);
    expect(s.reviewMessageId).toBe("m1"); // m1 still has quote "1"
  });
});

describe("createReviewComment", () => {
  test("commits the quote, targets its block, and opens its note editor", () => {
    const id = createReviewComment(CONV, "m9", 2, "the chunk");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]).toEqual([expect.objectContaining({ id, messageId: "m9", blockIndex: 2, quote: "the chunk", body: "" })]);
    expect(s.reviewMessageId).toBe("m9");
    expect(s.reviewActiveBlock).toBe(2);
    expect(s.reviewEditingId).toBe(id);
  });
});
