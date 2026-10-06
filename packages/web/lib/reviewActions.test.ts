import { test, expect, describe, beforeEach } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { takeReviewBatch, attachReviewToMessage, createReviewComment, addImagePin, quotedImages, answerProposalCard, pendingAnswerOf, proposalAnswersOf, replyItemsOf, takeProposalAnswers, submitReview, cancelReview, batchSendWords } from "./reviewActions";
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

  test("each pin names its picture's attachment number and its marker drawn on it; a picture pinned twice attaches once", () => {
    const a = addImagePin(CONV, { ...shot, width: 1600, height: 900 }, { x: 0.25, y: 0.5 });
    const b = addImagePin(CONV, { ...shot, width: 1600, height: 900 }, { x: 0.9, y: 0.1 });
    const c = addImagePin(CONV, remote, { x: 0.5, y: 0.5 });
    const s = useInboxStore.getState();
    s.commitReviewComment(CONV, a, "this button is misaligned");
    s.commitReviewComment(CONV, b, "and this badge overlaps");
    s.commitReviewComment(CONV, c, "wrong color");
    expect(quotedImages(CONV)).toEqual([{ storageId: "s1", src: shot.src, markers: [{ x: 0.25, y: 0.5, number: 1 }, { x: 0.9, y: 0.1, number: 2 }] }]);
    const text = attachReviewToMessage(CONV, "fix these", 3);
    const blocks = text.split("\n\n");
    expect(blocks[0]).toBe("> [Image 3] at marker 1\n> " + blocks[0].split("\n> ")[1]);
    expect(blocks[1]).toBe("this button is misaligned");
    expect(blocks[2]).toStartWith("> [Image 3] at marker 2\n");
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

// A card answers the agent (org-staffing.md S39): the answers share the
// quotes' batch, one per card, and the send applies them and writes them.
describe("proposal answers in the batch", () => {
  const P = { id: "p-1", short_id: "op-1", title: "Tidy ops" };
  const card = (key: string, seqs: number[], sentence: string, ordinal?: number) => ({ proposal: P, key, change_ids: seqs.map((n) => `ch-${n}`), seqs, sentence, ordinal });
  const ROWS = {
    "ch-1": { _id: "ch-1", proposal_id: "p-1", seq: 1, change: { kind: "retire", handle: "ops" }, rationale: "r", evidence: [], status: "proposed" },
    "ch-2": { _id: "ch-2", proposal_id: "p-1", seq: 2, change: { kind: "retire", handle: "qa" }, rationale: "r", evidence: [], status: "proposed", revision: { kind: "amended", at: 7 } },
    "ch-3": { _id: "ch-3", proposal_id: "p-1", seq: 3, change: { kind: "retire", handle: "x" }, rationale: "r", evidence: [], status: "proposed" },
  };
  let dispatched: [string, unknown[]][] = [];
  beforeEach(() => {
    dispatched = [];
    (useInboxStore.getState() as any)._setDispatch((action: string, args: unknown[]) => { dispatched.push([action, args]); return Promise.resolve(undefined); });
    useInboxStore.setState({ orgProposalChanges: JSON.parse(JSON.stringify(ROWS)), orgProposals: { "p-1": { _id: "p-1", short_id: "op-1", title: "Tidy ops", status: "open" } } } as any);
  });
  const answers = () => proposalAnswersOf(useInboxStore.getState().reviewComments[CONV], "p-1");

  test("one answer per card: a new verdict replaces it, words on the same verdict edit it in place, null and a second bare approve withdraw it", () => {
    answerProposalCard(CONV, card("role:ops", [1], "Retire ops.", 1), { verdict: "approve" });
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "reject", text: "keep qa" });
    expect(answers().map((c) => [c.proposal.card, c.proposal.verdict, c.body, c.quote, c.messageId])).toEqual([["role:ops", "approve", "", "Retire ops.", ""], ["role:qa", "reject", "keep qa", "Retire qa.", ""]]);
    const qaId = answers()[1].id;
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "reject", text: "keep qa, it ships" });
    expect(answers()[1]).toMatchObject({ id: qaId, body: "keep qa, it ships" });
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "note", text: "who takes its work?" });
    expect(answers().map((c) => c.proposal.verdict)).toEqual(["approve", "note"]);
    expect(pendingAnswerOf(useInboxStore.getState().reviewComments[CONV], "p-1", "role:qa")?.body).toBe("who takes its work?");
    expect(pendingAnswerOf(useInboxStore.getState().reviewComments[CONV], "p-1", "role:x")).toBeUndefined();
    // Approve pressed again withdraws. A note's blank words stay while the field is open mid thought; no words at all is no answer.
    answerProposalCard(CONV, card("role:ops", [1], "Retire ops.", 1), null);
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "note", text: "  " });
    expect(answers().map((c) => [c.proposal.card, c.body])).toEqual([["role:qa", "  "]]);
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "note", text: "" });
    expect(answers()).toEqual([]);
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined();
  });

  test("leave the sessions rides on an approval and reaches the proposal's reply once; a blank note is dropped at the take", () => {
    answerProposalCard(CONV, card("role:ops", [1], "Retire ops.", 1), { verdict: "approve", leave_sessions: true });
    expect(answers()[0].proposal.leave_sessions).toBe(true);
    const id = answers()[0].id;
    // Unticked: the same item, rewritten without it. On a rejection the tick means nothing.
    answerProposalCard(CONV, card("role:ops", [1], "Retire ops.", 1), { verdict: "approve" });
    expect(answers()[0].proposal.leave_sessions).toBeUndefined();
    answerProposalCard(CONV, card("role:ops", [1], "Retire ops.", 1), { verdict: "approve", leave_sessions: true });
    expect(answers()[0].id).not.toBe(id);
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "reject", text: "no", leave_sessions: true });
    expect(answers()[1].proposal.leave_sessions).toBeUndefined();
    answerProposalCard(CONV, card("role:x", [3], "Retire x.", 3), { verdict: "note", text: "   " });
    expect(replyItemsOf(useInboxStore.getState().reviewComments[CONV], "p-1")).toEqual([
      { verdict: "approve", change_ids: ["ch-1"], seqs: [1] },
      { verdict: "reject", change_ids: ["ch-2"], seqs: [2], text: "no" },
    ]);
    const text = attachReviewToMessage(CONV, "");
    expect(text).toBe('On op-1:\n- Approved, and applied: op-1#1.\n- Rejected op-1#2 (retire qa): no');
    const [, args] = dispatched.find(([a]) => a === "replyOnOrgProposal")!;
    expect(args[3]).toEqual({ leave_sessions: true });
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined();
    // Only blank notes pending: nothing is sent and the batch is cleared.
    answerProposalCard(CONV, card("role:x", [3], "Retire x.", 3), { verdict: "note", text: " " });
    expect(attachReviewToMessage(CONV, "hi")).toBe("hi");
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined();
    expect(dispatched.filter(([a]) => a === "replyOnOrgProposal")).toHaveLength(1);
  });

  test("the send takes the answers first: one replyOnOrgProposal per proposal with seen from the rows, their words lead the message, then the quotes, then what was typed", () => {
    seed([mk("q1", 0, "the agent's line", "my note")]);
    answerProposalCard(CONV, card("role:ops", [1], "Retire ops.", 1), { verdict: "approve" });
    answerProposalCard(CONV, card("role:x", [3], "Retire x.", 3), { verdict: "approve" });
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "reject", text: "keep qa" });
    answerProposalCard(CONV, card("", [], "", undefined), { verdict: "note", text: "do the plans next" });
    const other = { id: "p-2", short_id: "op-2", title: "Second" };
    answerProposalCard(CONV, { proposal: other, key: "goal:g", change_ids: ["ch-9"], seqs: [1], sentence: "Add the goal G.", ordinal: 1 }, { verdict: "note", text: "later" });
    const items = [
      { verdict: "approve", change_ids: ["ch-1"], seqs: [1] },
      { verdict: "approve", change_ids: ["ch-3"], seqs: [3] },
      { verdict: "reject", change_ids: ["ch-2"], seqs: [2], text: "keep qa" },
      { verdict: "note", change_ids: [], seqs: [], text: "do the plans next" },
    ];
    expect(replyItemsOf(useInboxStore.getState().reviewComments[CONV], "p-1")).toEqual(items);
    const text = attachReviewToMessage(CONV, "and thanks");
    expect(text).toBe([
      'On op-1:',
      "- Approved, and applied: op-1#1 and op-1#3.",
      "- Rejected op-1#2 (retire qa): keep qa",
      "- On the whole proposal: do the plans next",
      "",
      'On op-2:',
      "- On op-2#1 (add the goal G): later",
      "",
      "> the agent's line",
      "",
      "my note",
      "",
      "and thanks",
    ].join("\n"));
    // Applied once per proposal, in the shape the dispatch rail sends to orgProposals.reply.
    const replies = dispatched.filter(([a]) => a === "replyOnOrgProposal");
    expect(replies.map(([, args]) => args[0])).toEqual(["p-1", "p-2"]);
    expect(replies[0][1][1]).toEqual(items);
    expect(replies[0][1][2]).toEqual({ revised_at: 7, seqs: [1, 2, 3] });
    expect(replies[0][1][3]).toEqual({});
    // The draft moved with the send, and the batch is empty.
    const s = useInboxStore.getState();
    expect(s.orgProposalChanges["ch-1"].status).toBe("accepted");
    expect(s.orgProposalChanges["ch-2"]).toMatchObject({ status: "skipped", reply: { verdict: "reject", text: "keep qa" } });
    expect(s.reviewComments[CONV]).toBeUndefined();
    // Nothing left to apply: a second send sends only what is typed.
    expect(attachReviewToMessage(CONV, "again")).toBe("again");
    expect(dispatched.filter(([a]) => a === "replyOnOrgProposal")).toHaveLength(2);
  });
  test("Edit in input materialises the quotes and leaves the answers; Clear discards both; a partial take never takes answers", () => {
    seed([mk("q1", 0, "quoted", "note")]);
    answerProposalCard(CONV, card("role:ops", [1], "Retire ops.", 1), { verdict: "reject", text: "no" });
    const populated: string[] = [];
    expect(submitReview(CONV, (t) => populated.push(t))).toBe(true);
    expect(populated).toEqual(["> quoted\n\nnote"]);
    expect(useInboxStore.getState().reviewComments[CONV]?.map((c) => c.proposal?.verdict)).toEqual(["reject"]);
    expect(dispatched.filter(([a]) => a === "replyOnOrgProposal")).toHaveLength(0);
    // With only answers left, Edit in input has nothing to materialise.
    expect(submitReview(CONV, (t) => populated.push(t))).toBe(false);
    seed([...useInboxStore.getState().reviewComments[CONV]!, { id: "plan", messageId: "m1#plan", blockIndex: 0, quote: "plan line", body: "", createdAt: 0 }]);
    expect(takeReviewBatch(CONV, "m1#plan")).toBe("> plan line");
    expect(useInboxStore.getState().reviewComments[CONV]?.map((c) => c.proposal?.verdict)).toEqual(["reject"]);
    cancelReview(CONV);
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined();
    expect(useInboxStore.getState().orgProposalChanges["ch-1"].status).toBe("proposed");
  });

  test("the subject rides on the item, so the tray can name the card or the group", () => {
    answerProposalCard(CONV, { ...card("role:ops", [1], "Retire ops.", 1), subject: "Ops" }, { verdict: "approve" });
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "reject", text: "no" });
    expect(answers().map((c) => c.proposal.subject)).toEqual(["Ops", undefined]);
    // A group's answer is one item over every member.
    answerProposalCard(CONV, { proposal: P, key: "group:pr-1", change_ids: ["ch-1", "ch-2", "ch-3"], seqs: [1, 2, 3], sentence: "Settle 3 records in Funnel", subject: "Funnel" }, { verdict: "approve" });
    expect(answers().map((c) => [c.proposal.card, c.proposal.change_ids.length, c.proposal.seqs, c.proposal.subject])).toEqual([["group:pr-1", 3, [1, 2, 3], "Funnel"]]);
  });

  test("batchSendWords counts the changes an approval applies, the answers with words, and the quotes, and words the head, the button and the placeholder", () => {
    const words = () => batchSendWords(useInboxStore.getState().reviewComments[CONV] ?? []);
    expect(words()).toEqual({ applies: 0, answers: 0, quotes: 0, head: null, button: null, placeholder: null });
    // Applies only: the ids are summed, not the items.
    answerProposalCard(CONV, { proposal: P, key: "group:pr-1", change_ids: ["ch-1", "ch-2"], seqs: [1, 2], sentence: "Settle 2 records" }, { verdict: "approve" });
    answerProposalCard(CONV, card("role:x", [3], "Retire x.", 3), { verdict: "approve" });
    expect(words()).toMatchObject({ applies: 3, answers: 0, quotes: 0, head: "3 changes will apply when you send", button: "Send and apply 3", placeholder: null });
    // Both: the answers follow; a blank note is no answer.
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "reject", text: "no" });
    answerProposalCard(CONV, { ...card("role:y", [4], "Retire y.", 4), change_ids: ["ch-4"] }, { verdict: "note", text: "  " });
    expect(words()).toMatchObject({ applies: 1, answers: 1, head: "1 change will apply when you send, and 1 answer goes with them", button: "Send and apply 1", placeholder: "Add a word if you like, or just send." });
    answerProposalCard(CONV, { ...card("role:y", [4], "Retire y.", 4), change_ids: ["ch-4"] }, { verdict: "note", text: "why?" });
    expect(words()).toMatchObject({ applies: 1, answers: 2, head: "1 change will apply when you send, and 2 answers go with them" });
    // With quotes the count trails the sentence.
    seed([...useInboxStore.getState().reviewComments[CONV]!, mk("q1", 0, "quoted", ""), mk("q2", 1, "quoted", "")]);
    expect(words()).toMatchObject({ quotes: 2, head: "1 change will apply when you send, and 2 answers go with them · 2 quotes", button: "Send and apply 1" });
    // Answers only.
    seed([]);
    answerProposalCard(CONV, card("role:qa", [2], "Retire qa.", 2), { verdict: "reject", text: "no" });
    expect(words()).toMatchObject({ applies: 0, answers: 1, head: "1 answer goes when you send", button: "Send 1 answer", placeholder: "Add a word if you like, or just send." });
    answerProposalCard(CONV, card("role:x", [3], "Retire x.", 3), { verdict: "note", text: "later" });
    seed([...useInboxStore.getState().reviewComments[CONV]!, mk("q1", 0, "quoted", "")]);
    expect(words()).toMatchObject({ answers: 2, quotes: 1, head: "2 answers go when you send · 1 quote", button: "Send 2 answers" });
    // Quotes only: today's words, and the icon stands.
    seed([mk("q1", 0, "quoted", ""), mk("q2", 1, "quoted", "note")]);
    expect(words()).toEqual({ applies: 0, answers: 0, quotes: 2, head: "2 quotes on your next message", button: null, placeholder: null });
    seed([mk("q1", 0, "quoted", "")]);
    expect(words().head).toBe("1 quote on your next message");
  });

  test("a send from a conversation adds say for a proposal whose thread is another conversation, and not for the thread's own", () => {
    const SENT_IN = "k57c6zk1n3m0p2q4r6s8t0v2w4x6y8z1";
    const other = { id: "p-2", short_id: "op-2", title: "Elsewhere" };
    useInboxStore.setState({
      orgProposalChanges: { ...JSON.parse(JSON.stringify(ROWS)), "ch-9": { _id: "ch-9", proposal_id: "p-2", seq: 1, change: { kind: "retire", handle: "z" }, rationale: "r", evidence: [], status: "proposed" } },
      orgProposals: {
        "p-1": { _id: "p-1", short_id: "op-1", title: "Tidy ops", status: "open", thread: { conversation_id: SENT_IN } },
        "p-2": { _id: "p-2", short_id: "op-2", title: "Elsewhere", status: "open", thread: { conversation_id: "t-other" } },
      },
    } as any);
    answerProposalCard(SENT_IN, card("role:ops", [1], "Retire ops.", 1), { verdict: "approve" });
    answerProposalCard(SENT_IN, { proposal: other, key: "role:z", change_ids: ["ch-9"], seqs: [1], sentence: "Retire z." }, { verdict: "approve" });
    const text = attachReviewToMessage(SENT_IN, "");
    expect(text).toBe(["On op-1:", "- Approved, and applied: op-1#1.", "", "On op-2:", "- Approved, and applied: op-2#1."].join("\n"));
    const replies = dispatched.filter(([a]) => a === "replyOnOrgProposal");
    expect(replies.map(([, args]) => args[0])).toEqual(["p-1", "p-2"]);
    expect(replies[0][1][3]).toEqual({});
    expect(replies[1][1][3]).toEqual({ say: { thread: "t-other", client_id: expect.stringMatching(/^optimistic_/) } });
    // No body: the typed words stay in this conversation; the server writes the reply into the author's thread.
    expect((replies[1][1][3] as { say: { body?: string } }).say.body).toBeUndefined();
    useInboxStore.setState({ pendingMessages: {} } as any);
  });

  test("a surface with no composer takes one proposal's answers with say, and the words are the same", () => {
    answerProposalCard("proposal:p-1", card("role:ops", [1], "Retire ops.", 1), { verdict: "approve" });
    const text = takeProposalAnswers("proposal:p-1", { proposalId: "p-1", say: { thread: "t-1", body: "thanks", client_id: "c-1" } });
    expect(text).toBe('On op-1:\n- Approved, and applied: op-1#1.');
    const [, args] = dispatched.find(([a]) => a === "replyOnOrgProposal")!;
    expect(args[3]).toEqual({ say: { thread: "t-1", body: "thanks", client_id: "c-1" } });
    expect(useInboxStore.getState().reviewComments["proposal:p-1"]).toBeUndefined();
    expect(takeProposalAnswers("proposal:p-1")).toBe("");
  });

  test("a refused reply on the conversation path posts one correction line into the same conversation; a say take and a refusal of another proposal post nothing", () => {
    // A real conversation id: the send goes now (a stub id would wait for its create).
    const THREAD = "k57c6zk1n3m0p2q4r6s8t0v2w4x6y8z0";
    const refuse = (proposalId: string, message: string) => useInboxStore.setState({ lastDispatchFailure: { action: "replyOnOrgProposal", args: [proposalId, [], { revised_at: 0, seqs: [] }, {}], message, at: Date.now() + 1 } } as any);
    const sentLines = () => (useInboxStore.getState().pendingMessages[THREAD] ?? []).map((m) => m.content);
    // The words went out; the server refuses the verdicts as revised. The correction names the proposal, says nothing applied, and carries the reason's first sentence.
    answerProposalCard(THREAD, card("role:ops", [1], "Retire ops.", 1), { verdict: "approve" });
    expect(attachReviewToMessage(THREAD, "")).toBe('On op-1:\n- Approved, and applied: op-1#1.');
    refuse("p-1", "Uncaught Error: op-1 was revised after this page read it; a verdict never lands on a change the person has not seen\n at handler");
    expect(sentLines()).toEqual(["Correction: my answers on op-1 above were refused and nothing was applied (op-1 was revised after this page read it; a verdict never lands on a change the person has not seen). Treat them as not given."]);
    const sends = dispatched.filter(([a]) => a === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0][1].slice(0, 2)).toEqual([THREAD, sentLines()[0]]);
    // The same refusal again: the send was corrected once.
    refuse("p-1", "again");
    expect(sentLines()).toHaveLength(1);
    // A proposal whose words went nowhere from here (a say take) gets no correction.
    answerProposalCard("proposal:p-1", card("role:x", [3], "Retire x.", 3), { verdict: "approve" });
    takeProposalAnswers("proposal:p-1", { proposalId: "p-1", say: { thread: "t-1", body: "", client_id: "c-2" } });
    refuse("p-1", "Forbidden");
    expect(sentLines()).toHaveLength(1);
    // Any other refusal, humanized.
    answerProposalCard(THREAD, card("role:x", [3], "Retire x.", 3), { verdict: "reject", text: "no" });
    attachReviewToMessage(THREAD, "");
    refuse("p-1", "Uncaught ConvexError: Only an admin can answer a proposal\n at handler");
    expect(sentLines()[1]).toBe("Correction: my answers on op-1 above were refused and nothing was applied (Only an admin can answer a proposal). Treat them as not given.");
    useInboxStore.setState({ pendingMessages: {}, lastDispatchFailure: null } as any);
  });
});
