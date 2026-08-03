import { describe, expect, test } from "bun:test";
import {
  danglingUserTurnIsReapable,
  isConversationRetired,
  parseReapCandidateRow,
  reapSkipBucket,
  resumeOwnerVerdict,
  stampedPaneReapEligibility,
  summarizeReapSkips,
  transcriptTailLastRealTimestamp,
} from "./daemon.js";
import type { ConversationLifecycle } from "./syncService.js";

// The three lifecycle defects confirmed on 2026-08-03, each reduced to the pure
// decision the daemon now makes before it acts:
//   D1 — the health sweep reconstituted killed conversations (isConversationRetired)
//   D3 — resume ignored ownership on local devices (resumeOwnerVerdict)
//   D4 — only cc-resume-* panes were reap candidates (parseReapCandidateRow +
//        stampedPaneReapEligibility)

describe("isConversationRetired", () => {
  test("a killed conversation must never be reconstituted", () => {
    // The exact incident shape: status=completed with inbox_killed_at stamped.
    expect(isConversationRetired({ status: "completed", inboxKilledAt: 1_700_000_000_000 })).toBe(true);
  });

  test("either signal alone is enough", () => {
    // killSession only sets status=completed when mark_completed is passed, so
    // inbox_killed_at can stand alone — and a conversation completed by any other
    // path is equally finished.
    expect(isConversationRetired({ status: "active", inboxKilledAt: 1 })).toBe(true);
    expect(isConversationRetired({ status: "completed" })).toBe(true);
  });

  test("a live conversation still reconstitutes (the crash-recovery case)", () => {
    expect(isConversationRetired({ status: "active" })).toBe(false);
    expect(isConversationRetired({ status: "active", inboxKilledAt: null })).toBe(false);
    // Hidden from the inbox is NOT retired: a stashed/dismissed agent keeps running.
    expect(isConversationRetired({ status: "active", inboxStashedAt: 1, inboxDismissedAt: 1 })).toBe(false);
  });

  test("unknown lifecycle fails OPEN — a Convex blip can't strand a live session", () => {
    expect(isConversationRetired(null)).toBe(false);
    expect(isConversationRetired(undefined)).toBe(false);
    expect(isConversationRetired({})).toBe(false);
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
  const row = (name: string, session = "", conv = "") => [name, session, conv].join("\t");

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

  test("a tmux too old to expand #{@opt} yields no stamps, so nothing is misidentified", () => {
    // Unexpanded format strings come back as the literal, not as a session id —
    // but the pane is simply uncollected (the resume prefixes still work).
    expect(parseReapCandidateRow("my-editor")).toBeNull();
    expect(parseReapCandidateRow("cc-resume-7206623b")?.kind).toBe("resume");
  });
});

describe("stampedPaneReapEligibility", () => {
  const lifecycle = (over: ConversationLifecycle): ConversationLifecycle => ({ status: "active", ...over });

  test("hidden from the inbox → eligible", () => {
    for (const field of ["inboxKilledAt", "inboxStashedAt", "inboxDismissedAt"] as const) {
      expect(stampedPaneReapEligibility(lifecycle({ [field]: 1_700_000_000_000 })).eligible).toBe(true);
    }
  });

  test("visible in the inbox → NEVER reaped, however idle", () => {
    expect(stampedPaneReapEligibility(lifecycle({}))).toEqual({ eligible: false, reason: "inbox-visible" });
  });

  test("a pinned card stays visible even when killed → never reaped", () => {
    // Mirrors shouldShowInInbox: `inbox_killed_at && !inbox_pinned_at` hides it,
    // so a pin keeps the card (and its agent) around.
    expect(stampedPaneReapEligibility(lifecycle({ inboxKilledAt: 1, inboxPinnedAt: 2 })))
      .toEqual({ eligible: false, reason: "pinned" });
  });

  test("unknown hide state fails CLOSED (opposite of the resurrection gate)", () => {
    // Can't reach Convex, or the lifecycle query isn't deployed: leave it running.
    expect(stampedPaneReapEligibility(null)).toEqual({ eligible: false, reason: "hide-state-unknown" });
    expect(stampedPaneReapEligibility(undefined).eligible).toBe(false);
    // A status-only lifecycle (the fallback query's shape) carries no hide flags,
    // so it reads as visible rather than as permission to kill.
    expect(stampedPaneReapEligibility({ status: "active" }).eligible).toBe(false);
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
    // classifyTranscriptTail returns "active" for both cases; only the trailing
    // role separates them. An open AskUserQuestion lives here too.
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

  test("a clean pass says so", () => {
    expect(summarizeReapSkips([])).toBe("none");
  });
});
