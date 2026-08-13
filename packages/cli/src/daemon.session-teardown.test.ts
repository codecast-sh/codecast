import { describe, expect, test } from "bun:test";
import {
  askUserQuestionStillPending,
  clearSessionTrackingForKill,
  conversationForbidsResurrection,
  danglingUserTurnIsReapable,
  derivedPaneNamesForConversation,
  isConversationRetired,
  killLocalPanesForConversation,
  parseReapCandidateRow,
  reapSkipBucket,
  registerManagedStartedSession,
  resumeOwnerVerdict,
  sessionKillTrackingSnapshot,
  stampedPaneReapEligibility,
  summarizeReapSkips,
  tmuxSessionIsSinglePane,
  transcriptTailLastRealTimestamp,
} from "./daemon.js";
import { SyncService, isMissingFunctionError, resetLifecycleQueryLatch, shouldProbeLifecycleQuery } from "./syncService.js";
import type { ConversationLifecycle } from "./syncService.js";

// Shorthands for the two provenances getConversationLifecycle can return. The
// distinction is load-bearing: "status-fallback" resolves by session id via
// `.first()` (the OLDEST twin, ct-36973) and carries no hide state at all.
const authoritative = (over: Partial<ConversationLifecycle> = {}): ConversationLifecycle =>
  ({ status: "active", hideStateKnown: true, source: "lifecycle", ...over });
const degraded = (over: Partial<ConversationLifecycle> = {}): ConversationLifecycle =>
  ({ status: "active", hideStateKnown: false, source: "status-fallback", ...over });
const TRUSTING = { trustStatusFallback: true };   // heartbeat reconstitution only
const STRICT = { trustStatusFallback: false };    // every other resurrection path

// The three lifecycle defects confirmed on 2026-08-03, each reduced to the pure
// decision the daemon now makes before it acts:
//   D1 — the health sweep reconstituted killed conversations (isConversationRetired)
//   D3 — resume ignored ownership on local devices (resumeOwnerVerdict)
//   D4 — only cc-resume-* panes were reap candidates (parseReapCandidateRow +
//        stampedPaneReapEligibility)

describe("isConversationRetired", () => {
  test("a killed conversation must never be reconstituted", () => {
    // The exact incident shape: status=completed with inbox_killed_at stamped.
    expect(isConversationRetired(authoritative({ status: "completed", inboxKilledAt: 1_700_000_000_000 }), STRICT)).toBe(true);
  });

  test("either signal alone is enough", () => {
    // killSession only sets status=completed when mark_completed is passed, so
    // inbox_killed_at can stand alone — and a conversation completed by any other
    // path is equally finished.
    expect(isConversationRetired(authoritative({ inboxKilledAt: 1 }), STRICT)).toBe(true);
    expect(isConversationRetired(authoritative({ status: "completed" }), STRICT)).toBe(true);
  });

  test("a live conversation still reconstitutes (the crash-recovery case)", () => {
    expect(isConversationRetired(authoritative(), STRICT)).toBe(false);
    expect(isConversationRetired(authoritative({ inboxKilledAt: null }), STRICT)).toBe(false);
    // Hidden from the inbox is NOT retired: a stashed/dismissed agent keeps running.
    expect(isConversationRetired(authoritative({ inboxStashedAt: 1, inboxDismissedAt: 1 }), STRICT)).toBe(false);
  });

  test("unknown lifecycle fails OPEN — a Convex blip can't strand a live session", () => {
    expect(isConversationRetired(null, STRICT)).toBe(false);
    expect(isConversationRetired(undefined, STRICT)).toBe(false);
    expect(isConversationRetired(null, TRUSTING)).toBe(false);
  });

  // The degraded signal resolves by session id through `.first()` — the OLDEST
  // twin. A wrong "completed" from it would refuse to resume a LIVE session, so
  // only the caller that can absorb a wrong refusal is allowed to act on it.
  test("the status-only fallback is ignored by every path but heartbeat reconstitution", () => {
    const killedLooking = degraded({ status: "completed" });
    expect(isConversationRetired(killedLooking, STRICT)).toBe(false);   // delivery / warm pool / repair
    expect(isConversationRetired(killedLooking, TRUSTING)).toBe(true);  // handleDeadSession
  });

  test("trust does not invent a verdict — a live-looking fallback still allows resume", () => {
    expect(isConversationRetired(degraded({ status: "active" }), TRUSTING)).toBe(false);
  });
});

// The gate as WIRED, not just its pure core: the .catch that must swallow a
// lookup failure into "not retired". A throwing Convex client here would
// otherwise take down every resume path at once.
describe("conversationForbidsResurrection (wired)", () => {
  test("fails OPEN when the lifecycle lookup throws", async () => {
    const boom = () => Promise.reject(new Error("connect ECONNREFUSED"));
    expect(await conversationForbidsResurrection("conv1", "sess1", "TEST", STRICT, boom)).toBe(false);
    expect(await conversationForbidsResurrection("conv1", "sess1", "TEST", TRUSTING, boom)).toBe(false);
  });

  test("fails OPEN when the lookup resolves null (unknown row)", async () => {
    const none = () => Promise.resolve(null);
    expect(await conversationForbidsResurrection("conv1", "sess1", "TEST", STRICT, none)).toBe(false);
  });

  test("blocks on an authoritative killed verdict", async () => {
    const killed = () => Promise.resolve(authoritative({ status: "completed", inboxKilledAt: 5 }));
    expect(await conversationForbidsResurrection("conv1", "sess1", "TEST", STRICT, killed)).toBe(true);
  });

  test("a degraded killed verdict blocks ONLY the trusting caller", async () => {
    const killed = () => Promise.resolve(degraded({ status: "completed" }));
    expect(await conversationForbidsResurrection("conv1", "sess1", "TEST", STRICT, killed)).toBe(false);
    expect(await conversationForbidsResurrection("conv1", "sess1", "TEST", TRUSTING, killed)).toBe(true);
  });
});

const LOCAL = "device-local-aaaaaaaa";
const PEER = "device-peer-bbbbbbbb";

describe("resumeOwnerVerdict", () => {
  test("a conversation owned by a LIVE peer is never resumed here (the D3 hole)", () => {
    // Pre-fix this rule existed only for remote daemons, so a session owned by a
    // live peer got resumed on both machines at once.
    expect(resumeOwnerVerdict({
      conversationId: "conv1",
      localDeviceId: LOCAL,
      isRemote: false,
      owner: { ownerDeviceId: PEER, ownerIsRemote: false, ownerOnline: true },
    })).toBe("owned_by_live_device");
  });

  test("a DEAD owner still fails over to this device (deliberate)", () => {
    expect(resumeOwnerVerdict({
      conversationId: "conv1",
      localDeviceId: LOCAL,
      isRemote: false,
      owner: { ownerDeviceId: PEER, ownerIsRemote: false, ownerOnline: false },
    })).toBe("proceed");
  });

  test("an unowned conversation is adopted by a local daemon", () => {
    expect(resumeOwnerVerdict({ conversationId: "conv1", localDeviceId: LOCAL, isRemote: false, owner: null })).toBe("proceed");
    expect(resumeOwnerVerdict({ conversationId: undefined, localDeviceId: LOCAL, isRemote: false, owner: null })).toBe("proceed");
  });

  test("this device owning it always proceeds, live or not", () => {
    for (const online of [true, false]) {
      expect(resumeOwnerVerdict({
        conversationId: "conv1",
        localDeviceId: LOCAL,
        isRemote: false,
        owner: { ownerDeviceId: LOCAL, ownerIsRemote: false, ownerOnline: online },
      })).toBe("proceed");
    }
  });

  test("a remote daemon manages ONLY what it owns (unchanged)", () => {
    expect(resumeOwnerVerdict({ conversationId: "conv1", localDeviceId: LOCAL, isRemote: true, owner: null })).toBe("remote_unowned");
    expect(resumeOwnerVerdict({
      conversationId: "conv1",
      localDeviceId: LOCAL,
      isRemote: true,
      owner: { ownerDeviceId: PEER, ownerIsRemote: false, ownerOnline: false },
    })).toBe("remote_unowned");
    expect(resumeOwnerVerdict({
      conversationId: "conv1",
      localDeviceId: LOCAL,
      isRemote: true,
      owner: { ownerDeviceId: LOCAL, ownerIsRemote: true, ownerOnline: true },
    })).toBe("proceed");
  });

  test("a remote daemon with no conversation id can't verify ownership → refuse", () => {
    expect(resumeOwnerVerdict({ conversationId: undefined, localDeviceId: LOCAL, isRemote: true, owner: null }))
      .toBe("remote_no_conversation");
  });

  test("the live-owner rule outranks the remote rule (same skip, clearer log)", () => {
    expect(resumeOwnerVerdict({
      conversationId: "conv1",
      localDeviceId: LOCAL,
      isRemote: true,
      owner: { ownerDeviceId: PEER, ownerIsRemote: false, ownerOnline: true },
    })).toBe("owned_by_live_device");
  });
});

describe("parseReapCandidateRow", () => {
  // Field order is stamps-then-name, separated by a PRINTABLE character — see
  // REAP_LIST_FORMAT. tmux rewrites control characters in format output to `_`
  // whenever the caller is not itself inside tmux, which the daemon never is.
  const row = (name: string, session = "", conv = "") => [session, conv, name].join("|");

  test("resume shells are candidates with or without stamps", () => {
    expect(parseReapCandidateRow(row("cc-resume-7206623b", "7206623b-5ba0-4e7c-b91e-f1f1ddeb9b31")))
      .toEqual({ tmux: "cc-resume-7206623b", sessionId: "7206623b-5ba0-4e7c-b91e-f1f1ddeb9b31", convId: null, kind: "resume" });
    expect(parseReapCandidateRow(row("cx-resume-019fc268"))?.kind).toBe("resume");
  });

  test("a codecast-stamped primary terminal is now a candidate (the D4 gap)", () => {
    // cc-<agent>-<convSuffix> panes were invisible to the reaper, so a stashed or
    // killed session's own terminal leaked forever.
    expect(parseReapCandidateRow(row("cc-claude-6f68a98bqm7z", "2a466fef-c989-4285-b754-ece01f6cdc92", "jx78rf6911tyzst2n8ks6f68a98bqm7z")))
      .toEqual({
        tmux: "cc-claude-6f68a98bqm7z",
        sessionId: "2a466fef-c989-4285-b754-ece01f6cdc92",
        convId: "jx78rf6911tyzst2n8ks6f68a98bqm7z",
        kind: "stamped",
      });
    // Either stamp alone identifies it.
    expect(parseReapCandidateRow(row("cc-codex-abc", "", "jx7conv"))?.kind).toBe("stamped");
  });

  test("an unstamped foreign pane is never a candidate", () => {
    // The user's own tmux sessions must stay out of the reaper entirely.
    expect(parseReapCandidateRow(row("my-editor"))).toBeNull();
    expect(parseReapCandidateRow(row("work", "  ", " "))).toBeNull();
    expect(parseReapCandidateRow("")).toBeNull();
  });

  test("unset stamps arrive as EMPTY fields, not missing ones (the real tmux output)", () => {
    // REAP_LIST_FORMAT always emits two separators; tmux expands an unset user
    // option to the empty string. Verified against live tmux:
    //   "7206623b-…||cc-resume-7206623b"   (no conversation stamp)
    expect(parseReapCandidateRow(row("cc-resume-7206623b", "7206623b-5ba0-4e7c-b91e-f1f1ddeb9b31", "")))
      .toEqual({ tmux: "cc-resume-7206623b", sessionId: "7206623b-5ba0-4e7c-b91e-f1f1ddeb9b31", convId: null, kind: "resume" });
    // A foreign pane: both stamps empty, separators still present.
    expect(parseReapCandidateRow(row("my-editor", "", ""))).toBeNull();
  });

  test("a separator inside a session name is part of the name", () => {
    expect(parseReapCandidateRow(row("my|odd|pane", "7206623b-5ba0-4e7c-b91e-f1f1ddeb9b31")))
      .toEqual({ tmux: "my|odd|pane", sessionId: "7206623b-5ba0-4e7c-b91e-f1f1ddeb9b31", convId: null, kind: "stamped" });
  });

  test("a tmux too old to expand #{@opt} is read as unstamped, never as a session id", () => {
    // Two degenerate shapes a modern tmux can't produce: the placeholder handed
    // back verbatim, and the bare name with no separators. Both must land on
    // "no stamps" — the pane is uncollected unless its NAME identifies it, the
    // conservative outcome. Reading a literal "#{@codecast_session_id}" as a
    // session id would hand the reaper a pane it cannot resolve.
    expect(parseReapCandidateRow("#{@codecast_session_id}|#{@codecast_conversation_id}|my-editor")).toBeNull();
    expect(parseReapCandidateRow("#{@codecast_session_id}|#{@codecast_conversation_id}|cc-claude-6f68a98bqm7z")).toBeNull();
    expect(parseReapCandidateRow("my-editor")).toBeNull();
    expect(parseReapCandidateRow("cc-resume-7206623b")?.kind).toBe("resume");
    expect(parseReapCandidateRow("cc-claude-6f68a98bqm7z")).toBeNull(); // unidentifiable without stamps
  });

  test("the pane name survives intact — a welded row would name a pane that doesn't exist", () => {
    // The bug this format change fixes: with a tab separator, tmux returned
    // "cc-resume-abc_<sessionid>_<convid>" as ONE field. It still looked like a
    // resume candidate (right prefix), so the reaper spent every pass trying to
    // kill panes under names no tmux session has ever had.
    const parsed = parseReapCandidateRow(row("cc-resume-7206623b", "7206623b-5ba0-4e7c-b91e-f1f1ddeb9b31", "jx7conv"));
    expect(parsed?.tmux).toBe("cc-resume-7206623b");
  });
});

describe("stampedPaneReapEligibility", () => {
  test("hidden from the inbox → eligible", () => {
    for (const field of ["inboxKilledAt", "inboxStashedAt", "inboxDismissedAt"] as const) {
      expect(stampedPaneReapEligibility(authoritative({ [field]: 1_700_000_000_000 })).eligible).toBe(true);
    }
  });

  test("visible in the inbox → NEVER reaped, however idle", () => {
    expect(stampedPaneReapEligibility(authoritative())).toEqual({ eligible: false, reason: "inbox-visible" });
  });

  test("a pinned card stays visible even when killed → never reaped", () => {
    // Mirrors shouldShowInInbox: `inbox_killed_at && !inbox_pinned_at` hides it,
    // so a pin keeps the card (and its agent) around.
    expect(stampedPaneReapEligibility(authoritative({ inboxKilledAt: 1, inboxPinnedAt: 2 })))
      .toEqual({ eligible: false, reason: "pinned" });
  });

  test("unknown hide state fails CLOSED (opposite of the resurrection gate)", () => {
    expect(stampedPaneReapEligibility(null)).toEqual({ eligible: false, reason: "hide-state-unknown" });
    expect(stampedPaneReapEligibility(undefined).eligible).toBe(false);
  });

  // The lie this used to tell: the status-only fallback carries NO hide fields,
  // and reading their absence as "not hidden" reported killed conversations as
  // visible-and-skipped in the audit log while the stamped reaper quietly no-oped
  // against an undeployed backend. Absence must report as absence.
  test("a degraded lifecycle reports hide-state-unknown, NOT inbox-visible", () => {
    expect(stampedPaneReapEligibility(degraded({ status: "active" })))
      .toEqual({ eligible: false, reason: "hide-state-unknown" });
    // Even when the degraded row happens to look killed, hide state is still unknown.
    expect(stampedPaneReapEligibility(degraded({ status: "completed" })).reason).toBe("hide-state-unknown");
  });
});

describe("tmuxSessionIsSinglePane", () => {
  // The reap gates only ever inspect :0.0, but killTmuxSessionAndTree takes the
  // whole tmux SESSION — so a split or a second window (the user's shell, another
  // live agent) would die on one idle pane's evidence.
  test("exactly one pane → safe to treat :0.0 as the whole session", () => {
    expect(tmuxSessionIsSinglePane("0.0\n")).toBe(true);
    expect(tmuxSessionIsSinglePane("0.0")).toBe(true);
  });

  test("a split or a second window → not safe", () => {
    expect(tmuxSessionIsSinglePane("0.0\n0.1\n")).toBe(false);   // split
    expect(tmuxSessionIsSinglePane("0.0\n1.0\n")).toBe(false);   // second window
  });

  test("empty/garbled output → not single (fail closed)", () => {
    expect(tmuxSessionIsSinglePane("")).toBe(false);
    expect(tmuxSessionIsSinglePane("   \n  \n")).toBe(false);
  });
});

describe("derivedPaneNamesForConversation", () => {
  const names = derivedPaneNamesForConversation("jx78rf6911tyzst2n8ks6f68a98bqm7z");

  test("covers EVERY launchable agent, not the old hardcoded four", () => {
    // opencode and pi mint cc-<agent>-* names too, and this sweep is the only
    // teardown on the owner-defer path — a missing id is an unkillable pane.
    for (const agent of ["claude", "codex", "cursor", "gemini", "opencode", "pi"]) {
      expect(names).toContain(`cc-${agent}-6f68a98bqm7z`);
    }
  });

  test("keys off the same 12-char conversation suffix start_session uses", () => {
    expect(names.every((n) => n.endsWith("-6f68a98bqm7z"))).toBe(true);
  });
});

// An in-flight resume that passed the gates BEFORE a kill can recreate the pane
// the sweep just removed. The sweep can't cancel that promise, but it must not
// leave the map entry behind for the next delivery to join.
describe("clearSessionTrackingForKill", () => {
  test("clears every per-session map the kill path owns", () => {
    const sid = "22222222-3333-4444-8555-666666666666";
    registerManagedStartedSession("jx7trackedconv0000000000000000000", sid, "cc-claude-trackingtest");
    expect(sessionKillTrackingSnapshot(sid).pane).toBe(true);

    clearSessionTrackingForKill(sid);
    expect(sessionKillTrackingSnapshot(sid)).toEqual({
      pane: false, resumeInFlight: false, resumeInFlightStarted: false, restarting: false, process: false,
    });
  });

  test("is a no-op for an unknown or missing session id", () => {
    expect(() => clearSessionTrackingForKill(undefined)).not.toThrow();
    expect(() => clearSessionTrackingForKill(null)).not.toThrow();
    expect(sessionKillTrackingSnapshot("never-seen").pane).toBe(false);
  });

  // THE race the sweep exists for, and the one the first version of it missed:
  // the kill lands after a resume passed the gates but BEFORE its pane exists.
  // Clearing state only next to a found pane means finding none clears nothing,
  // and the in-flight resume completes into a killed conversation.
  // (clearConversationDeliveryAndResumeState does not cover these maps — it
  // touches resumeFatalReasons/deliveryFailures/repairAttempts, never resumeInFlight.)
  test("a sweep that finds ZERO panes still clears the in-flight maps", async () => {
    const sid = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    // A conversation id whose derived cc-<agent>-* names cannot exist, and a
    // session id no live pane is stamped with — so the sweep matches nothing.
    const convId = "jx7nosuchconversation000000000000";
    registerManagedStartedSession(convId, sid, "cc-claude-zeropanetest");
    expect(sessionKillTrackingSnapshot(sid).pane).toBe(true);

    const killed = await killLocalPanesForConversation(convId, sid, "TEST");
    expect(killed).toBe(0);
    // Proof the unconditional clear ran: clearSessionTrackingForKill empties every
    // map in one body (covered above), so the pane bit flipping is the whole set.
    expect(sessionKillTrackingSnapshot(sid).pane).toBe(false);
  });
});

describe("lifecycle query latch", () => {
  // A latch that trips on ANY error silently disables the resurrection gate for
  // the daemon's whole life on one DNS blip. Only a missing function is permanent.
  test("only a missing-function error latches", () => {
    expect(isMissingFunctionError(new Error(
      "Could not find public function for 'conversations:getConversationLifecycle'. Did you forget to run `npx convex deploy`?",
    ))).toBe(true);
    expect(isMissingFunctionError(new Error("function not found"))).toBe(true);
  });

  test("transient failures do NOT latch", () => {
    for (const msg of [
      "connect ECONNREFUSED 127.0.0.1:443",
      "Request timed out after 30000ms",
      "502 Bad Gateway",
      "getaddrinfo ENOTFOUND convex.cloud",
      "Unauthorized",
    ]) {
      expect(isMissingFunctionError(new Error(msg))).toBe(false);
    }
    expect(isMissingFunctionError(undefined)).toBe(false);
    expect(isMissingFunctionError("some string")).toBe(false);
  });

  test("a latched-off query re-probes so a deploy (or a wrong latch) heals", () => {
    const SIX_H = 6 * 60 * 60 * 1000;
    expect(shouldProbeLifecycleQuery(0, 1_000)).toBe(true);              // never latched
    expect(shouldProbeLifecycleQuery(1_000, 1_000 + SIX_H - 1)).toBe(false);
    expect(shouldProbeLifecycleQuery(1_000, 1_000 + SIX_H)).toBe(true);  // re-probe due
  });
});

// The permanent `transcript=active` block — the actual reason panes accumulate.
// An agent that died mid-turn leaves the user's unanswered prompt last, which
// classifyTranscriptTail reads as "the agent's move" forever. On this machine 25
// of 267 idle Claude transcripts are stuck that way, the oldest 682h.
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("danglingUserTurnIsReapable", () => {
  const dangling = (ageHours: number, over: Partial<Parameters<typeof danglingUserTurnIsReapable>[0]> = {}) =>
    danglingUserTurnIsReapable({
      turn: "active",
      lastRealRole: "user",
      lastRealTimestampMs: NOW - ageHours * HOUR,
      askSidecarMtimeMs: null,
      paneIdle: true,
      now: NOW,
      ...over,
    });

  test("dangling user turn + >24h + idle pane → reapable", () => {
    expect(dangling(25)).toBe(true);
    expect(dangling(325)).toBe(true); // the real fc9eed88 shape
    expect(dangling(24)).toBe(true);  // exactly at the bar
  });

  test("dangling user turn under 24h → still blocked", () => {
    // Past the 5h mtime gate but not the raised bar: the agent may yet answer.
    expect(dangling(23)).toBe(false);
    expect(dangling(6)).toBe(false);
  });

  test("a pending tool_use is real in-flight work — blocked at ANY age", () => {
    expect(dangling(682, { lastRealRole: "assistant" })).toBe(false);
    expect(dangling(10_000, { lastRealRole: "assistant" })).toBe(false);
  });

  test("only rescues the 'active' verdict, never invents one", () => {
    expect(dangling(500, { turn: "idle" })).toBe(false);
    expect(dangling(500, { turn: "unknown" })).toBe(false);
  });

  test("a busy pane vetoes it however old the turn is", () => {
    expect(dangling(682, { paneIdle: false })).toBe(false);
  });

  test("no parseable timestamp → no honest clock → keep blocking", () => {
    // Never fall back to mtime here: mtime is what lies.
    expect(dangling(682, { lastRealTimestampMs: null })).toBe(false);
    expect(dangling(682, { lastRealRole: null })).toBe(false);
  });

  // THE REAL AskUserQuestion SHAPE. Claude Code buffers the AUQ tool_use out of
  // the JSONL until it is answered, so a question-blocked session's tail ends in
  // a USER turn (the previous, already-resolved tool_result) — indistinguishable
  // from a dangling turn by role alone. An earlier version of this test asserted
  // lastRealRole "assistant" for this case, which is the opposite of the on-disk
  // shape and let the hatch through with only a footer regex protecting it.
  test("a pending question (user tail + newer sidecar) is NEVER reaped", () => {
    const lastMsg = NOW - 300 * HOUR;
    expect(danglingUserTurnIsReapable({
      turn: "active", lastRealRole: "user", lastRealTimestampMs: lastMsg,
      askSidecarMtimeMs: lastMsg + 90_000, // question asked after the last message
      paneIdle: true, now: NOW,
    })).toBe(false);
  });

  test("an ANSWERED question (sidecar older than the last message) still reaps", () => {
    // The sidecar is never deleted, so this is the common case — 3 of the 5 stuck
    // panes carrying a sidecar here had answered their questions weeks earlier.
    const lastMsg = NOW - 300 * HOUR;
    expect(danglingUserTurnIsReapable({
      turn: "active", lastRealRole: "user", lastRealTimestampMs: lastMsg,
      askSidecarMtimeMs: lastMsg - 60_000,
      paneIdle: true, now: NOW,
    })).toBe(true);
  });
});

describe("askUserQuestionStillPending", () => {
  // Ordering, not existence: ~/.codecast/ask-input/<sid>.json is written when a
  // question is asked and NEVER removed (123 files here, back to June), so
  // "a sidecar exists" would permanently retire the escape hatch as sessions each
  // accumulate one. Answering flushes the buffered turn AND appends the answer,
  // so the transcript gains a message newer than the sidecar.
  test("sidecar newer than the last message → still waiting on the user", () => {
    expect(askUserQuestionStillPending(2_000, 1_000)).toBe(true);
  });

  test("sidecar older than the last message → answered, transcript moved on", () => {
    expect(askUserQuestionStillPending(1_000, 2_000)).toBe(false);
    expect(askUserQuestionStillPending(1_000, 1_000)).toBe(false); // not strictly newer
  });

  test("no sidecar → this session never asked a question", () => {
    expect(askUserQuestionStillPending(null, 2_000)).toBe(false);
  });

  test("sidecar but no message clock → can't order them → assume pending", () => {
    expect(askUserQuestionStillPending(2_000, null)).toBe(true);
  });
});

describe("transcriptTailLastRealTimestamp", () => {
  const msg = (role: string, timestamp?: string) =>
    JSON.stringify({ type: role, timestamp, message: { role, content: [{ type: "text", text: "hi" }] } });
  const meta = () => JSON.stringify({ type: "mode", mode: "default", sessionId: "x" });

  test("reads the last real turn's timestamp, skipping meta lines", () => {
    // Real shape: Claude writes `mode` / `permission-mode` lines after the turn,
    // and those carry no timestamp — reading them would yield null every time.
    expect(transcriptTailLastRealTimestamp([
      msg("user", "2026-07-20T10:00:00.000Z"),
      meta(),
      meta(),
    ].join("\n"))).toBe(Date.parse("2026-07-20T10:00:00.000Z"));
  });

  test("skips a partial/corrupt final line (mid-write tail)", () => {
    expect(transcriptTailLastRealTimestamp([
      msg("assistant", "2026-07-20T10:00:00.000Z"),
      '{"type":"assist',
    ].join("\n"))).toBe(Date.parse("2026-07-20T10:00:00.000Z"));
  });

  test("a real turn with no/unparseable timestamp → null, never a guess", () => {
    expect(transcriptTailLastRealTimestamp(msg("user"))).toBeNull();
    expect(transcriptTailLastRealTimestamp(msg("user", "not a date"))).toBeNull();
    expect(transcriptTailLastRealTimestamp([meta(), meta()].join("\n"))).toBeNull();
    expect(transcriptTailLastRealTimestamp("")).toBeNull();
  });
});

describe("reaper pass summary", () => {
  test("collapses the idle-age detail so one bucket per reason", () => {
    expect(reapSkipBucket("active-37min")).toBe("active");
    expect(reapSkipBucket("active-303min")).toBe("active");
    expect(reapSkipBucket("pane=busy")).toBe("pane=busy");
    expect(reapSkipBucket("no-transcript")).toBe("no-transcript");
  });

  test("commonest reason first — the line answers 'why did nothing get reaped'", () => {
    expect(summarizeReapSkips([
      "no-transcript", "pane=busy", "no-transcript", "active-12min",
      "no-transcript", "pane=busy", "active-300min", "inbox-visible",
    ])).toBe("no-transcript×3, active×2, pane=busy×2, inbox-visible×1");
  });

  test("the new skip reasons are distinguishable in the tally", () => {
    // Each names a different root cause, and conflating them is what made the
    // reaper look inert: an undeployed query, an attached split, and a live
    // question are three very different reasons to do nothing.
    expect(summarizeReapSkips(["hide-state-unknown", "multi-pane", "pending-question", "transcript=active"]))
      .toBe("hide-state-unknown×1, multi-pane×1, pending-question×1, transcript=active×1");
  });

  test("a clean pass says so", () => {
    expect(summarizeReapSkips([])).toBe("none");
  });
});

// Route selection inside getConversationLifecycle. The ghost case is the whole
// reason a fallback exists: the conversation id we were handed no longer
// resolves, but the session is alive under a twin. Routing that to the devices
// query would take the OLDEST twin AND lose every hide field; the lifecycle
// query's session route takes the NEWEST and keeps them.
describe("getConversationLifecycle routing", () => {
  const LIFECYCLE = "conversations:getConversationLifecycle";
  const DEVICES = "devices:resolveConversationBySession";
  const liveRow = {
    status: "active", inbox_killed_at: null, inbox_stashed_at: 1_700_000_000_000,
    inbox_dismissed_at: null, inbox_pinned_at: null,
  };

  // Stubs the Convex client and records which (name, selector) pairs were called.
  function serviceWith(handler: (name: string, args: any) => unknown) {
    resetLifecycleQueryLatch();
    const calls: Array<{ name: string; selector: string }> = [];
    const svc = new SyncService(
      { convexUrl: "http://localhost:0", userId: "u", authToken: "t" },
    );
    (svc as any).client = {
      query: async (name: string, args: any) => {
        calls.push({ name, selector: args.conversation_id ? "conversation_id" : "session_id" });
        return handler(name, args);
      },
    };
    return { svc, calls };
  }

  test("an existing row resolves by conversation id and stops there", async () => {
    const { svc, calls } = serviceWith((name) => (name === LIFECYCLE ? liveRow : null));
    const got = await svc.getConversationLifecycle("conv-live", "sess-1");
    expect(got).toMatchObject({ hideStateKnown: true, source: "lifecycle", inboxStashedAt: 1_700_000_000_000 });
    expect(calls).toEqual([{ name: LIFECYCLE, selector: "conversation_id" }]);
  });

  test("a GHOST id falls through to the session route and keeps full hide state", async () => {
    // Route A misses (deleted/remapped row); route B finds the live twin.
    const { svc, calls } = serviceWith((name, args) =>
      name === LIFECYCLE && args.session_id ? liveRow : null);
    const got = await svc.getConversationLifecycle("conv-ghost", "sess-1");
    expect(got).toMatchObject({ hideStateKnown: true, source: "lifecycle", inboxStashedAt: 1_700_000_000_000 });
    expect(calls).toEqual([
      { name: LIFECYCLE, selector: "conversation_id" },
      { name: LIFECYCLE, selector: "session_id" },
    ]);
    // The oldest-twin, status-only query must not be consulted at all.
    expect(calls.some((c) => c.name === DEVICES)).toBe(false);
  });

  test("both routes answering 'no such conversation' returns null, not a devices miss", async () => {
    const { svc, calls } = serviceWith(() => null);
    expect(await svc.getConversationLifecycle("conv-gone", "sess-1")).toBeNull();
    expect(calls.map((c) => c.name)).toEqual([LIFECYCLE, LIFECYCLE]); // no devices call
  });

  test("an UNDEPLOYED query (both routes missing) still uses the devices fallback", async () => {
    const { svc, calls } = serviceWith((name) => {
      if (name === LIFECYCLE) throw new Error("Could not find public function for 'conversations:getConversationLifecycle'");
      return { status: "completed" };
    });
    const got = await svc.getConversationLifecycle("conv-1", "sess-1");
    expect(got).toEqual({ status: "completed", hideStateKnown: false, source: "status-fallback" });
    expect(calls[calls.length - 1].name).toBe(DEVICES);
  });

  test("a transient error does not latch, and still degrades to devices for this call", async () => {
    const { svc } = serviceWith((name) => {
      if (name === LIFECYCLE) throw new Error("connect ECONNREFUSED 127.0.0.1:443");
      return { status: "active" };
    });
    expect(await svc.getConversationLifecycle("conv-1", "sess-1")).toMatchObject({ source: "status-fallback" });
    // Latch untouched: the next call probes the real query again.
    expect(shouldProbeLifecycleQuery(0, Date.now())).toBe(true);
  });

  test("no session id means no ghost route and no fallback", async () => {
    const { svc, calls } = serviceWith(() => null);
    expect(await svc.getConversationLifecycle("conv-gone")).toBeNull();
    expect(calls).toEqual([{ name: LIFECYCLE, selector: "conversation_id" }]);
  });
});
