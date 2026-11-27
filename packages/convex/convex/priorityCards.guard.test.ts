// THE RULE for priority change cards (on isPriorityCard, shared/contracts/
// priorityCard.ts): a card belongs to its person alone and is acted on only
// through the card. Two review rounds found decision features built for a
// session's own questions leaking into cards (a pass, a docked ask, a run's
// wait, a cancel). This guard keeps the sweep's record:
//
// 1. Every server function that reads decisions by session
//    (session_decisions.by_conversation_status) or hands a decision to
//    someone else (writes asked_user_ids, passed_to, holder_key or stack_id)
//    is classified here: it handles priority cards (and then names the
//    predicate, or calls a function that does) or deliberately ignores them,
//    with why. A new one fails until someone classifies it.
// 2. Every named chokepoint (server, web and phone) still tests the rule.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = import.meta.dir;
const PACKAGES = join(ROOT, "../..");

/** What names the rule in a function body. */
const PREDICATE = /\b(isPriorityCard|notPriorityCard|liftsAskingSession|priorityCardVisibleTo|priorityCardRefusal|openForHandoff|sessionAsk|handable)\b/;

/** `via`: the function it hands the row to, which names the rule (it must call it, and that one must name the rule). */
type Kind = { handles: string; via?: string } | { ignores: string };

/** "file:function" -> how it treats a priority card. */
const CLASSIFIED: Record<string, Kind> = {
  // Reads of one session's decisions.
  "sessionDecisions.ts:askCore": { handles: "a re-ask never reuses the card and other_open never lists it" },
  "sessionDecisions.ts:listForSessionCore": { handles: "`cast decide ls` never lists it" },
  "sessionDecisions.ts:reroutePendingDecisionsForConversation": { handles: "rerouteRow skips it", via: "rerouteRow" },
  "sessionDecisions.ts:findByAnswer": { handles: "a card's row is never anyone's but its person's to find" },
  "sessionDecisions.ts:carriedHops": { ignores: "reads withdrawn rows of one task; a card has no task" },
  "agentTasks.ts:routeUpWaitingSession": { handles: "a card in the session does not count as its open question" },
  "lib/agentOwnerWaits.ts:routeWaitToAgentOwner": { handles: "a card in the session does not count as its open question" },
  "sessionOwnership.ts:rehomeSessions": { handles: "a card in the session does not keep it in front" },
  "workflow_runs.ts:openDecisionOf": { handles: "a run's station card is never the priority card" },
  "workflow_runs.ts:withdrawOpenGate": { handles: "a run that ends never withdraws the card" },
  "lib/gateChoices.ts:standingCard": { handles: "a station's standing card is never the priority card" },
  "lib/taskVerdicts.ts:personAnswersIn": { handles: "an answered card is no verdict on the session's work" },
  "lib/decisionTeam.ts:restampDecisionTeams": { handles: "a card is routed by its workspace, not its session's team" },
  "lib/decisionPush.ts:releaseDecisionPushes": { ignores: "a card is silent: it never pushes" },
  "lib/decisionRing.ts:cardsWaitingOn": { ignores: "counts ringing cards only (ringsPhone); a card is silent" },
  "lib/conversationRows.ts:CONVERSATION_ROW_TABLES": { ignores: "deleting a session deletes its rows; a card's corrections stay pending for the next pass" },
  // Hand-offs: who it is asked of, who holds it, which stack it sits in.
  "decisionHandoff.ts:passCore": { handles: "openForHandoff refuses a card" },
  "decisionHandoff.ts:escalateCore": { handles: "openForHandoff refuses a card" },
  "decisionHandoff.ts:unassignCore": { ignores: "takes back a pass; a card is never passed (openForHandoff)" },
  "decisionShareOut.ts:shareOutCore": { ignores: "Share out moves only rows movable() keeps, and it leaves silent ones" },
  "sessionDecisions.ts:rerouteRow": { handles: "an owner change never reroutes a card" },
  "sessionDecisions.ts:refreshHolder": { ignores: "recomputes the holder from asked_user_ids, which nothing moves on a card" },
  "sessionDecisions.ts:restoreAskedPeople": { ignores: "a by-hand repair, run on a named decision" },
  "decisionStacks.ts:addToStackCore": { handles: "a card never joins a stack (its delegate and defaults would take it)" },
  "decisionStacks.ts:removeFromStackCore": { ignores: "a card is never in a stack" },
  "lib/personWait.ts:settlePersonWaitCard": { ignores: "hands on only the cards a person wait asked itself, named by the session's waiting_on; a priority card is never one" },
};

/** Named chokepoints that must still test the rule: [file under packages/, function or const]. */
const CHOKEPOINTS: Array<[string, string]> = [
  ["convex/convex/sessionDecisions.ts", "answerRefusal"],
  ["convex/convex/sessionDecisions.ts", "ownedDecision"],
  ["convex/convex/sessionDecisions.ts", "decisionRowsForViewer"],
  // Every read path that gates on userMayRead (get, getWithDoc, getWithDocMany, showForCli, listForRole, the team list, threads, discussions) gets this.
  ["convex/convex/lib/decisionAccess.ts", "userMayRead"],
  ["convex/convex/sessionDecisions.ts", "listHandledByRoles"],
  ["convex/convex/decisionStacks.ts", "getStackCore"],
  ["convex/convex/decisionHandoff.ts", "openForHandoff"],
  ["convex/convex/conversations.ts", "loadPendingDecisionConvIds"],
  ["convex/convex/lib/priorityCardApply.ts", "settlePriorityCard"],
  ["web/lib/decisionQueue.ts", "pendingDecisionConvIds"],
  ["web/hooks/useDecisionQueue.ts", "sessionAsk"],
  ["web/lib/decisions/decisionBulk.ts", "handable"],
  ["web/components/SessionDecisionCard.tsx", "SessionDecisionCard"],
  ["web/components/decisions/DecisionAnswerControls.tsx", "GenericAnswerControls"],
  ["mobile/app/decisions/[id].tsx", "DecisionScreen"],
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

function serverFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (!["_generated", "node_modules", "__tests__"].includes(f)) serverFiles(p, out);
    } else if (p.endsWith(".ts") && !/\.(test|testkit)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const READ = /query\(\s*"session_decisions"\s*\)[\s\S]{0,60}?\.withIndex\(\s*"by_conversation_status"|\["session_decisions",\s*"by_conversation_status"\]/g;
const HAND = /\.patch\([^;]{0,240}?\b(asked_user_ids|passed_to|holder_key|stack_id)\s*:/g;

/** Every "file:function" that reads decisions by session or hands one off, with each file's source. */
function found(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of serverFiles(ROOT)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("session_decisions") && !/asked_user_ids|passed_to|holder_key|stack_id/.test(src)) continue;
    for (const re of [READ, HAND]) for (const m of src.matchAll(re)) out.set(`${relative(ROOT, file)}:${enclosing(src, m.index!)}`, src);
  }
  // A stack_id patch on a non-decision table (a trial project's stack) is not a hand-off.
  out.delete("lib/trialDecision.ts:ensureTrialStack");
  for (const key of [...out.keys()]) if (key.startsWith("lib/trialDecision.ts:")) out.delete(key);
  return out;
}

describe("priority cards: every session-scoped decision read and hand-off is classified", () => {
  const seen = found();

  test("nothing new goes unclassified", () => {
    const unclassified = [...seen.keys()].filter((k) => !(k in CLASSIFIED)).sort();
    expect(unclassified).toEqual([]);
  });

  test("nothing classified is gone (a renamed function is classified again)", () => {
    expect(Object.keys(CLASSIFIED).filter((k) => !seen.has(k)).sort()).toEqual([]);
  });

  for (const [key, kind] of Object.entries(CLASSIFIED)) {
    if (!("handles" in kind)) continue;
    test(`${key} names the rule: ${kind.handles}`, () => {
      const [file, name] = key.split(":");
      const src = seen.get(key) ?? readFileSync(join(ROOT, file), "utf8");
      const body = bodyOf(src, name);
      if (kind.via) {
        expect(body && new RegExp(`\\b${kind.via}\\(`).test(body)).toBe(true);
        const via = bodyOf(src, kind.via);
        expect(via && PREDICATE.test(via)).toBe(true);
      } else expect(body && PREDICATE.test(body)).toBe(true);
    });
  }
});

describe("priority cards: the named chokepoints still test the rule", () => {
  for (const [file, name] of CHOKEPOINTS) {
    test(`${file}: ${name}`, () => {
      const body = bodyOf(readFileSync(join(PACKAGES, file), "utf8"), name);
      expect(body).not.toBeNull();
      expect(PREDICATE.test(body!)).toBe(true);
    });
  }
});
