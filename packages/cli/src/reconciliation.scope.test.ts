import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performReconciliation } from "./reconciliation.js";
import { TEST_SCRATCH_DIRNAME } from "./syncScope.js";

// Regression for the phantom "stuck syncs … last sync 20618 days ago" alarm.
//
// The sync loop refuses to sync any project carrying the test-scratch marker
// (isProjectAllowedToSync → false). Reconciliation, however, used to scan ALL of
// ~/.claude/projects with no such filter: it found these never-synced test
// transcripts, asked the backend "do you have them?", got "no" (correctly), flagged
// them `missing_backend`, and "repaired" them by writing a lastSyncedPosition:0
// ledger entry to force a re-sync the sync loop will never perform. That zero
// entry (lastSyncedAt:0) then surfaced forever as a stuck sync, its epoch-0
// timestamp formatting as "20618 days ago".
//
// The fix: reconciliation honors the SAME scope rule as the sync loop. A
// test-scratch transcript must never be queried against the backend, and so can
// never become a discrepancy (and thus never a zombie ledger entry).
describe("reconciliation honors the sync-scope rule (skips test-scratch transcripts)", () => {
  const uuid = (n: string) => `${n}1111111-2222-4333-8444-555555555555`;

  test("a test-scratch transcript is neither queried nor flagged; a normal one is", async () => {
    const realHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-reconcile-scope-"));
    const projects = path.join(tmpHome, ".claude", "projects");

    // Normal project: must be reconciled.
    const normalDir = path.join(projects, "-Users-someone-src-app");
    const normalSid = uuid("a");
    // Scratch project: carries the marker → must be skipped, exactly like the
    // real ~/.claude/projects/-private-var-folders-…-codecasttestscratch-… dirs.
    const scratchDir = path.join(projects, `-private-var-folders-T-${TEST_SCRATCH_DIRNAME}-inject-clear-1-2`);
    const scratchSid = uuid("b");

    fs.mkdirSync(normalDir, { recursive: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n";
    fs.writeFileSync(path.join(normalDir, `${normalSid}.jsonl`), line);
    fs.writeFileSync(path.join(scratchDir, `${scratchSid}.jsonl`), line);

    // Fake backend: capture which session ids reconciliation asks about, return
    // "nothing found" for all of them (the condition that triggered the bug).
    let queried: string[] = [];
    const fakeSyncService = {
      async getMessageCountsForReconciliation(sessionIds: string[]) {
        queried = sessionIds;
        return [];
      },
    } as any;

    try {
      process.env.HOME = tmpHome;
      const result = await performReconciliation(fakeSyncService, () => {}, {}, 50);

      // The normal transcript was scanned, queried, and (backend empty) flagged.
      expect(queried).toContain(normalSid);
      expect(result.discrepancies.some(d => d.sessionId === normalSid)).toBe(true);

      // The scratch transcript was skipped before the backend query, so it can
      // never become a discrepancy — and therefore never a zombie ledger entry.
      expect(queried).not.toContain(scratchSid);
      expect(result.discrepancies.some(d => d.sessionId === scratchSid)).toBe(false);
    } finally {
      process.env.HOME = realHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
