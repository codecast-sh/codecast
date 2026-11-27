// THE RULE for priority change cards, on the web (isPriorityCard,
// shared/contracts/priorityCard.ts): a card belongs to its person alone and
// is acted on only through the card; no surface treats it as its session's
// question. Three review rounds in a row found web surfaces built for a
// session's own questions drawing a card as one: the stepper opened its
// session, the cards view grouped it under the session's name and linked to
// the ask, a bulk dismiss took it, the owner button offered to assign it, the
// agent dock and an org role listed it as the session's ask.
//
// 1. Every web function that ties a decision row to its session (reads the
//    row's conversation_id or a queue item's conversationId, jumps to the ask,
//    hands a decision on, dismisses it, opens the assign palette) is
//    classified here: it handles priority cards, and its body names the rule
//    (or calls a function in the same file that does), or it deliberately
//    ignores them, with why. A new one fails until someone classifies it.
// 2. Every named chokepoint still names the rule.
// The server's own sweep is convex/convex/priorityCards.guard.test.ts.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB = join(import.meta.dir, "../..");

/** What names the rule in a function body. */
const PREDICATE = /\b(isPriorityCard|priority_card|priorityCard|sessionAsk|handable|pendingDecisionConvIds|PRIORITIES_SCOPE|usePriorityCardIds|cardIds)\b/;

/** `via`: a function in the same file it hands the row to, which names the rule. */
type Kind = { handles: string; via?: string } | { ignores: string };

/** "file:function" (from packages/web) -> how it treats a priority card. */
const CLASSIFIED: Record<string, Kind> = {
  // Where a card is drawn, listed or answered.
  "components/DecisionQueue.tsx:DecisionQueue": { handles: "the stepper draws the card itself, never the session it sits in" },
  "components/SessionDecisionCard.tsx:SessionDecisionCard": { handles: "a session's docked card never shows a priority card" },
  "components/decisions/AnsweredFeed.tsx:FeedEntry": { handles: "draws the card's record and no link to its session" },
  "components/decisions/DecisionAnswerControls.tsx:GenericAnswerControls": { handles: "no pass or generic answers for a card" },
  "components/decisions/DecisionCompactCard.tsx:DecisionCompactCard": { handles: "the view names the pass, not the session, and has no thread or stack box", via: "DecisionCompactCardView" },
  "components/decisions/DecisionDocument.tsx:DocumentBody": { handles: "no Talk to the session, Comment for the team or Open the session" },
  "components/decisions/DecisionListRow.tsx:DecisionListRow": { handles: "no owner button to assign it" },
  "components/decisions/DecisionParties.tsx:AskingSession": { handles: "AskingSessionView draws nothing for a card", via: "AskingSessionView" },
  "components/decisions/DecisionParties.tsx:AskingSessionView": { handles: "no session name or link to the ask for a card" },
  "components/decisions/InboxDecisionQueue.tsx:InboxDecisionQueue": { handles: "lists the card by its short form, under no session" },
  "components/agentDock/AgentDock.tsx:AgentDock": { handles: "the dock never lists a card as its session's ask" },
  "hooks/useDecisionQueue.ts:sessionAsk": { handles: "a card is not among its session's docked asks" },
  "lib/decisionGroups.ts:decisionScopeKey": { handles: "a card files under Priorities, never its session" },
  "lib/decisionQueue.ts:pendingDecisionConvIds": { handles: "a card never lifts its session as asking" },
  "lib/decisions/decisionBulk.ts:assignDecisions": { handles: "no bulk verb takes a card (handable)" },
  "lib/decisions/decisionBulk.ts:unassignDecisions": { handles: "no bulk verb takes a card (handable)" },
  "lib/decisions/decisionBulk.ts:passDecisions": { handles: "no bulk verb takes a card (handable)" },
  "lib/decisions/decisionBulk.ts:escalateDecisions": { handles: "no bulk verb takes a card (handable)" },
  "lib/decisions/decisionBulk.ts:dismissDecisions": { handles: "no bulk verb takes a card (handable)" },
  // Deliberately not about cards, and why.
  "lib/priorityCardDecision.ts:priorityCardAnswerInput": { ignores: "the card's own answers, Accept none among them: called only by the card" },
  "components/DecisionAnswerQuote.tsx:DecisionAnswerQuote": { ignores: "draws an answer message a transcript already holds; it lists no session's open decisions" },
  "components/GlobalSessionPanel.tsx:decisionsSectionSig": { ignores: "a re-render signature; the section it wakes is InboxDecisionQueue" },
  "components/activity/useActivityItems.ts:decisionsSig": { ignores: "a re-render signature; useActivityItems leaves cards out (a chokepoint below)" },
  "components/conversation/HostedApprovalCard.tsx:HostedApprovalCard": { ignores: "a hosted session's permission ask, never a decide row" },
  "components/conversation/PermissionAsk.tsx:PermissionAskCard": { ignores: "a session's permission ask, never a decide row" },
  "components/conversation/blocks/castBlocks.tsx:CastDecideBlock": { ignores: "a `cast decide` the session ran itself; a pass's card is never asked from a transcript" },
  "components/decisions/DecisionAnswering.tsx:useDecisionAnswering": { ignores: "answers the decision on screen; for a card that is the card's own answer" },
  "components/decisions/DecisionQueueList.tsx:DecisionQueueList": { ignores: "decide rows group through groupDecisions (decisionScopeKey files a card under Priorities); its conversationId list is terminal asks" },
  "components/decisions/PassDecision.tsx:PassDecision": { ignores: "offered only by SessionDecisionCard and GenericAnswerControls, which never offer it for a card; the server refuses one (openForHandoff)" },
  "components/line/widgets/LineDecision.tsx:Asker": { ignores: "a line run's gate; a card is never a flow decision" },
  "components/line/widgets/LineDecision.tsx:LineDecisionBody": { ignores: "a line run's gate; a card is never a flow decision" },
  "components/line/widgets/LineDecision.tsx:Talk": { ignores: "a line run's gate; a card is never a flow decision" },
  "components/line/widgets/OriginTrail.tsx:OriginTrail": { ignores: "a line card's path from its problem; a priority card has none" },
  "components/org/orgDecisions.ts:orgDecisions": { ignores: "pure over the items it is handed; useOrgAsks leaves cards out (a chokepoint below)" },
  "components/simple/lane.ts:isOpenApproval": { ignores: "a session's own approval, never a decide row" },
  "components/threads/kinds/QuestionKind.tsx:QuestionExpanded": { ignores: "draws question threads, which questionCards never makes for a card (a chokepoint below)" },
  "components/threads/kinds/QuestionKind.tsx:QuestionLabel": { ignores: "draws question threads, which questionCards never makes for a card" },
  "hooks/inboxWarm.ts:warmDecisionsSig": { ignores: "prefetch order only; warming a session draws nothing" },
  "hooks/inboxWarm.ts:warmOrder": { ignores: "prefetch order only; warming a session draws nothing" },
  "hooks/useDecisionAnswer.ts:useDecisionAnswer": { ignores: "answers the item a session's card shows, which is never a priority card" },
  "hooks/useDecisionQueue.ts:buildDecisionQueue": { ignores: "a card belongs in its person's queue; each surface that draws an item is classified" },
  "hooks/useDecisionStep.ts:useQueueOrder": { ignores: "the queue's order only" },
  "hooks/useJumpToDecisionAsk.ts:locateDecisionAsk": { ignores: "the jump itself; every caller that could jump for a card is classified" },
  "hooks/useRunningPermission.ts:useRunningPermission": { ignores: "a session's running permission, never a decide row" },
  "hooks/useThreadsSync.ts:useCommentThreadMap": { ignores: "comment threads on a conversation, not decisions" },
  "lib/decisionQueue.ts:decisionQueueItems": { ignores: "builds the person's queue, where a card belongs" },
  "lib/decisionQueue.ts:hostedDeclinedSince": { ignores: "a hosted session's declined approvals, never a card" },
  "lib/liveEntities.ts:resolveTaskRelatedDocs": { ignores: "a task's docs; a card has no task" },
  "lib/threadCards.ts:serverCards": { ignores: "comment and chat threads, not decisions" },
};

/** Named chokepoints that must still name the rule: [file under packages/web, function or const]. */
const CHOKEPOINTS: Array<[string, string]> = [
  ["components/activity/useActivityItems.ts", "useActivityItems"],
  ["components/org/useNeedsYou.ts", "useOrgAsks"],
  ["lib/threadCards.ts", "questionCards"],
  ["components/decisions/DecisionPalette.tsx", "DecisionPalette"],
  ["components/decisions/DecisionQueueList.tsx", "ScopeLabel"],
  ["components/decisions/DecisionCompactCard.tsx", "DecisionCompactCardView"],
  ["hooks/usePriorityCardIds.ts", "usePriorityCardIds"],
];

const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\b)/;

/** The top-level declaration each line of `src` sits in. */
function enclosing(src: string, index: number): string {
  const lines = src.slice(0, index).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = DECL.exec(lines[i]);
    if (m) return m[1] ?? m[2];
  }
  return "?";
}

/** The body of the top-level declaration `name` in `src`: its line to the next top-level declaration. */
function bodyOf(src: string, name: string): string | null {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => { const m = DECL.exec(l); return !!m && (m[1] ?? m[2]) === name; });
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !DECL.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

const SKIP_DIRS = new Set(["node_modules", "__tests__", "__fixtures__", "(marketing)", "acmeWorld"]);
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(f)) sourceFiles(p, out);
    } else if (/\.tsx?$/.test(p) && !/\.(test|markup|mount)\.tsx?$|\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
}

/** A file that handles decision rows or queue items. */
const ROWS = /SessionDecisionItem|sessionDecisions|\bQueueItem\b|useDecisionQueue\(/;
/** A decision tied to its session, or handed on, or dismissed. */
const SIGNAL = /useJumpToDecisionAsk\(|\b(?:d|decision|row|dec|item|it|q|r)\.conversation_id\b|\b(?:item|it|q|i|current|a\.item)\.conversationId\b|\b(?:passDecision|escalateDecision|unassignDecision)\(|dismiss:\s*true|<PassDecision\b|onOpenPalette\(/g;

/** Every "file:function" that ties a decision row to its session, with each file's source. */
function found(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of ["components", "lib", "hooks", "app"]) {
    for (const file of sourceFiles(join(WEB, dir))) {
      const src = readFileSync(file, "utf8");
      if (!ROWS.test(src)) continue;
      for (const m of src.matchAll(SIGNAL)) out.set(`${relative(WEB, file)}:${enclosing(src, m.index!)}`, src);
    }
  }
  return out;
}

describe("priority cards on the web: every function that ties a decision to its session is classified", () => {
  const seen = found();

  test("nothing new goes unclassified", () => {
    expect([...seen.keys()].filter((k) => !(k in CLASSIFIED)).sort()).toEqual([]);
  });

  test("nothing classified is gone (a renamed function is classified again)", () => {
    expect(Object.keys(CLASSIFIED).filter((k) => !seen.has(k)).sort()).toEqual([]);
  });

  for (const [key, kind] of Object.entries(CLASSIFIED)) {
    if (!("handles" in kind)) continue;
    test(`${key} names the rule: ${kind.handles}`, () => {
      const [file, name] = key.split(":");
      const src = seen.get(key) ?? readFileSync(join(WEB, file), "utf8");
      const body = bodyOf(src, name);
      if (kind.via) {
        expect(body && new RegExp(`\\b${kind.via}\\b`).test(body)).toBe(true);
        const via = bodyOf(src, kind.via);
        expect(via && PREDICATE.test(via)).toBe(true);
      } else expect(body && PREDICATE.test(body)).toBe(true);
    });
  }
});

describe("priority cards on the web: the named chokepoints still name the rule", () => {
  for (const [file, name] of CHOKEPOINTS) {
    test(`${file}: ${name}`, () => {
      const body = bodyOf(readFileSync(join(WEB, file), "utf8"), name);
      expect(body).not.toBeNull();
      expect(PREDICATE.test(body!)).toBe(true);
    });
  }
});
