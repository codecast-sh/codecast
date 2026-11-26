// The machine-originated readers of the retirement marker (inbox_killed_at):
// stall checks, report-ups, route-ups, settle classification, stuck-send
// notices, pane recovery, cloud and machine starts, the parent-asking lift.
// Each must treat a closed session (shared isClosedSession) as it treats a
// killed one, or a machine report undoes a close. Three review rounds found a
// reader that did not know about Close; this list is the sweep's record, and
// a reader dropped from it, or a guard removed from one, fails here. A real
// wake (a send, a trigger, a run report) is deliberately NOT on this list.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const READERS: Array<[file: string, guard: string]> = [
  ["notifications.ts", "if (isClosedSession(conv)) return { notified: false, reason: \"closed\" };"],
  ["workerSettle.ts", "if (isClosedSession(worker)) return { told: 0, reason: \"closed\" };"],
  ["workerSettle.ts", "c.hand_wake_notified_key === episodeOf(c) || isClosedSession(c)"],
  ["agentTasks.ts", "if (conv.inbox_killed_at || isClosedSession(conv)) return \"nobody\";"],
  ["idleSummary.ts", "if (isClosedSession(conv)) return { scheduled: false, reason: \"closed\" };"],
  ["pendingMessages.ts", "senderConv.inbox_killed_at || isClosedSession(senderConv)"],
  ["cloudPlacement.ts", "conv.inbox_killed_at || isClosedSession(conv) || conv.status === \"completed\""],
  ["accountSwitch.ts", "conv.inbox_killed_at != null || isClosedSession(conv)"],
  ["castMachines.ts", "!conv || conv.inbox_killed_at || isClosedSession(conv)"],
  ["lib/paneRefusal.ts", "!unattended || conv.inbox_killed_at || isClosedSession(conv)"],
  ["lib/sessionTell.ts", "const hold = line.hold || isClosedSession(conversation) || isClosedHidden(conversation);"],
  ["conversations.ts", "if (c.inbox_killed_at || isClosedSession(c)) continue;"],
  ["conversations.ts", "c.inbox_killed_at || isClosedSession(c) || !pooledAt"],
  ["conversations.ts", "if (isClosedSession(conv)) return;"],
];

describe("machine readers of the retirement marker know about Close", () => {
  for (const [file, guard] of READERS) {
    test(`${file}: ${guard.slice(0, 60)}`, () => {
      expect(readFileSync(join(import.meta.dir, file), "utf8")).toContain(guard);
    });
  }
});
