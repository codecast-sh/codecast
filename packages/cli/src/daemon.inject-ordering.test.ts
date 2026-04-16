import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the "doubled assistant message" bug (root-caused 2026-04-14).
//
// Root cause recap: inside deliverMessage(), each delivery path (cached-tmux inject,
// live-tmux inject, terminal inject, auto-resume, repair+resume, started-session
// inject) used to flip the pending_messages row to "injected" AFTER calling the
// actual inject. The inject triggers Claude to write the user message to its JSONL
// within milliseconds; the daemon's JSONL watcher then syncs the message and calls
// ackInjectedMessages, which only flips "injected" -> "delivered". If the ack runs
// before the mark (a window observed as narrow as 36ms in David's daemon logs), it
// finds no injected row and does nothing. The daemon's subsequent mark leaves the
// row stuck as "injected", and the 120s retry cron resets it to "pending" and the
// daemon re-delivers the same message -- producing two identical assistant replies.
//
// The fix: mark "injected" BEFORE every delivery-path inject, so the ack always
// finds a row to flip regardless of which side of the race wins. On inject failure
// the same 120s retry cron recovers -- identical to today's worst case.
//
// This test is a static invariant check against daemon.ts -- it does not execute
// the daemon. It guards against a regression where someone re-inserts the mark
// after an inject call in deliverMessage.

const daemonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "daemon.ts",
);
const daemonSource = fs.readFileSync(daemonPath, "utf8");

function extractDeliverMessageBody(): string {
  const startMarker = "async function deliverMessage";
  const startIdx = daemonSource.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error(`deliverMessage not found in ${daemonPath}`);
  }
  // deliverMessage ends where the next top-level helper begins.
  const endIdx = daemonSource.indexOf("\nfunction isSyncPaused", startIdx);
  if (endIdx < 0) {
    throw new Error("Could not locate end of deliverMessage (isSyncPaused anchor missing)");
  }
  return daemonSource.slice(startIdx, endIdx);
}

const deliverBody = extractDeliverMessageBody();

function lineNumberOf(body: string, charOffset: number): number {
  let count = 1;
  for (let i = 0; i < charOffset && i < body.length; i++) {
    if (body.charCodeAt(i) === 10 /* \n */) count++;
  }
  return count;
}

describe("deliverMessage: mark-injected-before-send invariant", () => {
  test("deliverMessage body is non-trivial (guards against extraction breaking silently)", () => {
    expect(deliverBody.length).toBeGreaterThan(2000);
    expect(deliverBody).toContain("injectViaTmux");
    expect(deliverBody).toContain("injectViaTerminal");
    expect(deliverBody).toContain("autoResumeSession");
    expect(deliverBody).toContain("repairAndResumeSession");
  });

  test("no inject call is immediately followed by a mark-injected call (the buggy pattern)", () => {
    // Match: await injectViaXxx(...); <up to ~3 lines, whitespace/comments> await syncService.updateMessageStatus({... status: "injected" ...})
    // A match here means the mark comes AFTER the inject -- the exact race this bug is about.
    const antiPattern =
      /await\s+(?:injectViaTmux|injectViaTerminal)\s*\([^;]*\);[ \t]*(?:\n[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)?[ \t]*){0,3}await\s+syncService\.updateMessageStatus\s*\(\s*\{[^}]*status:\s*["']injected["']/g;

    const matches: Array<{ line: number; snippet: string }> = [];
    for (const m of deliverBody.matchAll(antiPattern)) {
      matches.push({
        line: lineNumberOf(deliverBody, m.index ?? 0),
        snippet: m[0].slice(0, 200),
      });
    }
    if (matches.length > 0) {
      const summary = matches
        .map((m) => `  - line ${m.line} (in deliverMessage): ${m.snippet.replace(/\s+/g, " ")}`)
        .join("\n");
      throw new Error(
        `Found ${matches.length} mark-after-inject site(s) -- this reintroduces the doubled-message race:\n${summary}`,
      );
    }
    expect(matches.length).toBe(0);
  });

  test("no autoResumeSession/repairAndResumeSession success branch marks injected AFTER the call", () => {
    // These calls are long-running (they spin up tmux + Claude and inject content),
    // so the ack race is even wider. The mark MUST precede the call.
    const antiPattern =
      /await\s+(?:autoResumeSession|repairAndResumeSession)\s*\([^;]*\);[\s\S]{0,500}?await\s+syncService\.updateMessageStatus\s*\(\s*\{[^}]*status:\s*["']injected["']/g;

    const matches: Array<{ line: number; snippet: string }> = [];
    for (const m of deliverBody.matchAll(antiPattern)) {
      // Only count if the mark is inside the immediate success branch (within 500 chars),
      // which is exactly where the old buggy code lived.
      matches.push({
        line: lineNumberOf(deliverBody, m.index ?? 0),
        snippet: m[0].slice(0, 250),
      });
    }
    if (matches.length > 0) {
      const summary = matches
        .map((m) => `  - line ${m.line} (in deliverMessage): ${m.snippet.replace(/\s+/g, " ")}`)
        .join("\n");
      throw new Error(
        `Found ${matches.length} mark-after-resume site(s) -- this reintroduces the doubled-message race:\n${summary}`,
      );
    }
    expect(matches.length).toBe(0);
  });

  test("every delivery-path injection is preceded by a mark-injected within a small window", () => {
    // Delivery-path inject calls are the ones that take `content` and a specific target.
    // Permission responses (e.g. injectViaTerminal(tty, "\r", ...)) are NOT delivery calls.
    //
    // Match delivery inject call-sites only: those whose first arg refers to a real
    // tmux target or tty AND whose content arg is `content` (the pending message body).
    const callSites = [
      /await\s+injectViaTmux\(\s*startedTmuxTarget\s*,\s*content\s*\)/g,
      /await\s+injectViaTmux\(\s*cachedTmux\s*,\s*content\s*\)/g,
      /await\s+injectViaTmux\(\s*tmuxTarget\s*,\s*content\s*\)/g,
      /await\s+injectViaTerminal\(\s*proc\.tty\s*,\s*content\s*,\s*proc\.termProgram\s*\)/g,
      /await\s+autoResumeSession\(\s*sessionId\s*,\s*content\s*,/g,
      /await\s+repairAndResumeSession\(\s*sessionId\s*,\s*content\s*,/g,
    ];

    let totalSitesChecked = 0;
    for (const rx of callSites) {
      for (const match of deliverBody.matchAll(rx)) {
        totalSitesChecked++;
        const idx = match.index ?? 0;
        // Look backwards ~20 lines for a mark-injected call.
        const windowStart = Math.max(0, idx - 1500);
        const window = deliverBody.slice(windowStart, idx);
        const hasPrecedingMark = /status:\s*["']injected["']/.test(window);
        if (!hasPrecedingMark) {
          const lineNo = lineNumberOf(deliverBody, idx);
          throw new Error(
            `Delivery injection at line ${lineNo} of deliverMessage has no preceding mark-injected within 1500 chars. Call: ${match[0]}`,
          );
        }
      }
    }

    // We must actually find the 6 known sites -- otherwise the test is silently vacuous.
    expect(totalSitesChecked).toBeGreaterThanOrEqual(6);
  });
});
