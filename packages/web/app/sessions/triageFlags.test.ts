import { describe, expect, it } from "bun:test";
import { deriveTriageFlags } from "./triageFlags";
import type { InboxSession } from "../../store/inboxStore";

// The defect ct-41083 is named for: /sessions derived `killed` from
// inbox_dismissed_at, a field the killSession mutation behind this page's own
// kill button never writes. (`cast kill` and the web inbox's kill action do
// write it — they were never the gap.)
type Row = Pick<InboxSession, "inbox_killed_at" | "inbox_dismissed_at" | "inbox_stashed_at">;

const row = (extra: Partial<Row> = {}): Row => ({
  inbox_killed_at: null,
  inbox_dismissed_at: null,
  inbox_stashed_at: null,
  ...extra,
});

describe("deriveTriageFlags", () => {
  it("reports a killed+pinned row (the only killed shape the inbox join delivers) as killed", () => {
    expect(deriveTriageFlags(row({ inbox_killed_at: 1_000 }))).toEqual({ killed: true, dismissed: true });
  });

  it("reports killed from the managed-session row flag, with no inbox join at all", () => {
    // The unpinned killed case: shouldShowInInbox drops it from the inbox
    // query, so the row flag is the ONLY source that can report it.
    expect(deriveTriageFlags(undefined, true)).toEqual({ killed: true, dismissed: true });
  });

  it("reports killed when the row flag is set even though the inbox join says nothing", () => {
    expect(deriveTriageFlags(row(), true)).toEqual({ killed: true, dismissed: true });
  });

  it("does NOT call a dismissed-but-alive row killed", () => {
    // The auto-tidy paths (agentTasks.ts) patch inbox_dismissed_at with no
    // teardown at all — those agents are alive and must not read as killed.
    expect(deriveTriageFlags(row({ inbox_dismissed_at: 1_000 }))).toEqual({ killed: false, dismissed: true });
  });

  it("does NOT call a stashed row killed — stash keeps the agent running", () => {
    expect(deriveTriageFlags(row({ inbox_stashed_at: 1_000 }))).toEqual({ killed: false, dismissed: true });
  });

  it("leaves an ordinary live row untouched on both axes", () => {
    expect(deriveTriageFlags(row())).toEqual({ killed: false, dismissed: false });
    expect(deriveTriageFlags(undefined)).toEqual({ killed: false, dismissed: false });
    expect(deriveTriageFlags(row(), false)).toEqual({ killed: false, dismissed: false });
  });

  it("keeps dismissed true whenever killed is true, so the badge always renders", () => {
    // The badge is gated on `dismissed` and only then picks its killed/stashed
    // label — a killed row with dismissed:false would render NO badge at all.
    for (const input of [
      deriveTriageFlags(row({ inbox_killed_at: 1 })),
      deriveTriageFlags(undefined, true),
      deriveTriageFlags(row({ inbox_killed_at: 1, inbox_stashed_at: 2 })),
    ]) {
      expect(input.killed).toBe(true);
      expect(input.dismissed).toBe(true);
    }
  });
});
