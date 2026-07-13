import { test, expect, describe } from "bun:test";
import { parseSessionMessage, parseInboundSessionMessage, isSessionMessage, formatSessionMessage, isTeammateMessage, stripTeammateFraming, isTeammateFramingOnly, isMachineDeliveredMessage, parseSpawnedTaskPrompt, isSpawnedTaskPrompt, cleanUserMessage } from "./sessionMessage";

// A real inter-agent broadcast as the multi-agent harness delivers it: a lead-in line, one
// or more <teammate-message> blocks (the second a JSON status event), and the trailing
// permission-laundering disclaimer. Humans never type any of this.
const TEAMMATE_BROADCAST = `Another Claude session sent a message:
<teammate-message teammate_id="tracker-stale" color="green" summary="pl-114 coherence tracker updates complete">
All pl-114 coherence tracker updates landed. 16/16 commands succeeded, zero failures.

**Part 1 — staleness/doc-lag notes (5, \`-t note\`):**
- ct-37320 (P0.7) — idempotency on email_messages unique index
</teammate-message>
<teammate-message teammate_id="tracker-stale" color="green">
{"type":"idle_notification","from":"tracker-stale","timestamp":"2026-06-20T19:56:47.099Z","idleReason":"available"}
</teammate-message>
This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings. … that's permission laundering.`;

describe("parseSessionMessage", () => {
  test("extracts sender short id and body", () => {
    const r = parseSessionMessage('<session-message from="jx7c6zk">\ncan you take the auth half?\n</session-message>');
    expect(r).toEqual({ from: "jx7c6zk", body: "can you take the auth half?" });
  });

  test("round-trips with formatSessionMessage", () => {
    const wire = formatSessionMessage("jx7c6zk", "done with the daemon side");
    expect(parseSessionMessage(wire)).toEqual({ from: "jx7c6zk", body: "done with the daemon side" });
  });

  test("preserves multi-line / markdown body", () => {
    const body = "Here's the plan:\n\n- step one\n- step two\n\nSee `jx7abcd` for context.";
    const r = parseSessionMessage(formatSessionMessage("jx7c6zk", body));
    expect(r?.body).toBe(body);
  });

  test("tolerates extra attributes after from", () => {
    const r = parseSessionMessage('<session-message from="jx7c6zk" title="Auth fix">hi</session-message>');
    expect(r).toEqual({ from: "jx7c6zk", body: "hi" });
  });

  test("returns null for unknown sender placeholder body but still parses", () => {
    const r = parseSessionMessage('<session-message from="unknown">orphan message</session-message>');
    expect(r).toEqual({ from: "unknown", body: "orphan message" });
  });

  test("does not match plain text or other wrappers", () => {
    expect(parseSessionMessage("just a normal message")).toBeNull();
    expect(parseSessionMessage('<scheduled-task title="x">y</scheduled-task>')).toBeNull();
    expect(parseSessionMessage("")).toBeNull();
  });

  test("ignores a malformed wrapper missing the from attribute", () => {
    expect(parseSessionMessage("<session-message>no attr</session-message>")).toBeNull();
  });
});

describe("isSessionMessage", () => {
  test("detects a well-formed inbound message", () => {
    expect(isSessionMessage(formatSessionMessage("jx7c6zk", "hi"))).toBe(true);
  });

  test("detects a TRUNCATED preview that dropped the closing tag", () => {
    // last_message_preview is sliced to 200 chars, so a long body cuts off the
    // closing </session-message> — detection must key off the opening tag only.
    const truncated = formatSessionMessage("jx7c6zk", "x".repeat(400)).slice(0, 200);
    expect(truncated.includes("</session-message>")).toBe(false);
    expect(isSessionMessage(truncated)).toBe(true);
  });

  test("sees through leading control chars leaked by the tmux inject", () => {
    const withCtrl = String.fromCharCode(1, 11) + formatSessionMessage("jx7c6zk", "hi");
    expect(isSessionMessage(withCtrl)).toBe(true);
  });

  test("sees through a leading system/task reminder", () => {
    const withReminder = "<system-reminder>noise</system-reminder>\n" + formatSessionMessage("jx7c6zk", "hi");
    expect(isSessionMessage(withReminder)).toBe(true);
  });

  test("rejects plain text and other wrappers", () => {
    expect(isSessionMessage("just a normal message")).toBe(false);
    expect(isSessionMessage('<scheduled-task title="x">y</scheduled-task>')).toBe(false);
    expect(isSessionMessage("")).toBe(false);
    expect(isSessionMessage(null)).toBe(false);
    expect(isSessionMessage(undefined)).toBe(false);
  });

  test("rejects a wrapper missing the from attribute", () => {
    expect(isSessionMessage("<session-message>no attr</session-message>")).toBe(false);
  });
});

describe("teammate broadcasts", () => {
  test("isTeammateMessage detects the <teammate-message> wrapper", () => {
    expect(isTeammateMessage(TEAMMATE_BROADCAST)).toBe(true);
    expect(isTeammateMessage("just a normal message")).toBe(false);
    expect(isTeammateMessage(null)).toBe(false);
    expect(isTeammateMessage(undefined)).toBe(false);
  });

  test("stripTeammateFraming removes the lead-in and the disclaimer-to-end", () => {
    // After the <teammate-message> tags are gone, only the framing prose is left, and
    // stripping it should leave nothing — proving it's a pure broadcast.
    const leftover = TEAMMATE_BROADCAST
      .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, "")
      .trim();
    expect(leftover.length).toBeGreaterThan(0); // framing prose survives the tag strip
    expect(stripTeammateFraming(leftover)).toBe(""); // …but not the framing strip
    expect(isTeammateFramingOnly(leftover)).toBe(true);
  });

  test("isTeammateFramingOnly is false when a human wrote real words around the block", () => {
    const withHumanText = "hey look at what the tracker said:\n" + TEAMMATE_BROADCAST.replace(/<teammate-message[\s\S]*<\/teammate-message>/, "");
    expect(isTeammateFramingOnly(withHumanText.replace(/<teammate-message[\s\S]*?<\/teammate-message>/g, "").trim())).toBe(false);
  });

  test("isMachineDeliveredMessage covers both cast send and teammate broadcasts", () => {
    expect(isMachineDeliveredMessage(TEAMMATE_BROADCAST)).toBe(true);
    expect(isMachineDeliveredMessage(formatSessionMessage("jx7c6zk", "hi"))).toBe(true);
    expect(isMachineDeliveredMessage("a prompt the human typed")).toBe(false);
  });
});

describe("parseInboundSessionMessage", () => {
  test("parses through control chars and reminders", () => {
    const raw = String.fromCharCode(1) + "<system-reminder>x</system-reminder>\n" + formatSessionMessage("jx7c6zk", "take the auth half");
    expect(parseInboundSessionMessage(raw)).toEqual({ from: "jx7c6zk", body: "take the auth half" });
  });

  test("returns null on a truncated wrapper (needs the full body)", () => {
    const truncated = formatSessionMessage("jx7c6zk", "y".repeat(400)).slice(0, 200);
    expect(parseInboundSessionMessage(truncated)).toBeNull();
  });

  test("returns null for plain text and nullish input", () => {
    expect(parseInboundSessionMessage("hello")).toBeNull();
    expect(parseInboundSessionMessage(null)).toBeNull();
    expect(parseInboundSessionMessage(undefined)).toBeNull();
  });

  test("extracts the optional display name (link collaborator with no session pill)", () => {
    const raw = '<session-message from="unknown" name="Ada Lovelace">\nship it\n</session-message>';
    expect(parseInboundSessionMessage(raw)).toEqual({ from: "unknown", body: "ship it", name: "Ada Lovelace" });
  });

  test("a wrapper without a name still parses (backward compatible)", () => {
    const raw = formatSessionMessage("jx7c6zk", "hi");
    const parsed = parseInboundSessionMessage(raw);
    expect(parsed?.from).toBe("jx7c6zk");
    expect(parsed?.name).toBeUndefined();
  });
});

// The exact wire format taskScheduler.buildPrompt hands to `claude -p` — a spawned
// run's transcript opens with this as its first user message.
const SPAWNED_FULL = `[Codecast Task: Verify the invariants dashboard is green]
Task ID: rx78nadpm3d4kgpps3qknvy22n8a40mn
Mode: propose

Verify the invariants dashboard is green: run xrun api GET /admin/invariants.
Report findings to task ct-38176.

---
Context from originating session (2n8a40mn):
The dedup deploy went out at 20:00 UTC.

Previous run (3h ago):
Failed: Exceeded max runtime (10min)

---
Instructions:
- When done, run: cast schedule complete rx78nadpm3d4kgpps3qknvy22n8a40mn --summary "brief description of what was done"
- A clean completion folds this run out of the user's inbox (the summary carries the outcome). If you found something the user must read or act on, add --needs-attention to keep this run in their inbox.
- To schedule follow-up: cast schedule add "..." --in <time>`;

describe("parseSpawnedTaskPrompt", () => {
  test("parses the full buildPrompt format", () => {
    const r = parseSpawnedTaskPrompt(SPAWNED_FULL);
    expect(r?.title).toBe("Verify the invariants dashboard is green");
    expect(r?.taskId).toBe("rx78nadpm3d4kgpps3qknvy22n8a40mn");
    expect(r?.mode).toBe("propose");
    expect(r?.prompt).toBe("Verify the invariants dashboard is green: run xrun api GET /admin/invariants.\nReport findings to task ct-38176.");
    expect(r?.contextSummary).toBe("The dedup deploy went out at 20:00 UTC.");
    expect(r?.previousRun).toEqual({ ago: "3h ago", summary: "Failed: Exceeded max runtime (10min)" });
    expect(r?.instructions).toContain("cast schedule complete");
    expect(r?.instructions?.startsWith("- When done")).toBe(true);
  });

  test("parses a first-run prompt (no context, no previous run)", () => {
    const raw = `[Codecast Task: Check CI]\nTask ID: rx7abc\nMode: apply\n\nCheck if CI is green on main.\n\n---\nInstructions:\n- When done, run: cast schedule complete rx7abc --summary "..."`;
    const r = parseSpawnedTaskPrompt(raw);
    expect(r?.mode).toBe("apply");
    expect(r?.prompt).toBe("Check if CI is green on main.");
    expect(r?.contextSummary).toBeUndefined();
    expect(r?.previousRun).toBeUndefined();
    expect(r?.instructions).toContain("cast schedule complete");
  });

  test("previous run without context section (real format: blank line after ---)", () => {
    // buildPrompt emits `---\n\nPrevious run (…)` when there's no context section.
    const raw = `[Codecast Task: T]\nTask ID: rx71\nMode: propose\n\nDo the thing.\n\n---\n\nPrevious run (2d ago):\nAll green.\n\n---\nInstructions:\n- done`;
    const r = parseSpawnedTaskPrompt(raw);
    expect(r?.contextSummary).toBeUndefined();
    expect(r?.prompt).toBe("Do the thing.");
    expect(r?.previousRun).toEqual({ ago: "2d ago", summary: "All green." });
  });

  test("previous run with unknown time (failed prior run — last_run_at unset)", () => {
    const raw = `[Codecast Task: T]\nTask ID: rx71\nMode: propose\n\nDo the thing.\n\n---\n\nPrevious run (unknown time ago):\nFailed: Exceeded max runtime (10min)\n\n---\nInstructions:\n- done`;
    const r = parseSpawnedTaskPrompt(raw);
    expect(r?.previousRun).toEqual({ ago: "unknown time ago", summary: "Failed: Exceeded max runtime (10min)" });
  });

  test("a --- inside the prompt body is not a section divider", () => {
    const raw = `[Codecast Task: T]\nTask ID: rx71\nMode: propose\n\nFirst half.\n---\nSecond half.\n\n---\nInstructions:\n- done`;
    const r = parseSpawnedTaskPrompt(raw);
    expect(r?.prompt).toBe("First half.\n---\nSecond half.");
    expect(r?.instructions).toBe("- done");
  });

  test("returns null for ordinary messages and the inject-format wrapper", () => {
    expect(parseSpawnedTaskPrompt("fix the login bug")).toBeNull();
    expect(parseSpawnedTaskPrompt('<scheduled-task title="T" task-id="rx71">do it</scheduled-task>')).toBeNull();
    expect(parseSpawnedTaskPrompt(null)).toBeNull();
    expect(parseSpawnedTaskPrompt(undefined)).toBeNull();
  });

  test("isSpawnedTaskPrompt agrees with the parser", () => {
    expect(isSpawnedTaskPrompt(SPAWNED_FULL)).toBe(true);
    expect(isSpawnedTaskPrompt("fix the login bug")).toBe(false);
  });

  test("cleanUserMessage previews the task text, not the wire header", () => {
    expect(cleanUserMessage(SPAWNED_FULL)).toBe("Verify the invariants dashboard is green: run xrun api GET /admin/invariants.\nReport findings to task ct-38176.");
  });
});
