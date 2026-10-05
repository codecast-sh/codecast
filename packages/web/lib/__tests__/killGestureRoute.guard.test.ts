import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A person's kill is one gesture with one route: the store's killSession /
// killSessions actions (through useTriggerKillNotice / animatedHideSessions),
// which paint the hide in the draft, record one undo entry with its Undo
// toast, and say which triggers died with it. The conversation command rail
// (convCommand(id, "killSession")) is a machine route the undo policy files
// as never-recorded: a kill sent over it vanishes the row from the inbox with
// no paint, no toast and nothing for ⌘Z to take back.
const ROOT = join(import.meta.dir, "..", "..");

// The Killed shelf's "Remove from list" acts on a row that is ALREADY killed
// (that kill was recorded when it happened); it only marks the session
// completed and drops it from the shelf, which is not a kill gesture.
const ALLOWED = new Set(["components/GlobalSessionPanel.tsx"]);

describe("kill gestures go through the recorded kill action", () => {
  test("no surface sends killSession over the conversation command rail", () => {
    const out = Bun.spawnSync(["git", "grep", "-lE", 'convCommand\\([^)]*"killSession"', "--", "app", "components", "hooks"], { cwd: ROOT });
    const files = out.stdout.toString().split("\n").filter((f) => f && !/(__tests__|\.test\.tsx?$)/.test(f));
    expect(files.filter((f) => !ALLOWED.has(f))).toEqual([]);
  }, 60_000);
});

// The recorded kill raises its own entry toast with the Undo button (the
// killSession(s) spec has toast: true), so a surface that adds a toast of its
// own after the call shows two toasts for one gesture, the second without an
// Undo and counting rows the action may have left out (a seat is retired, not
// killed). gestureToast is the one way to word a gesture's toast. (A side
// notice about something else, such as which schedules stay armed, is not
// the gesture's toast and is left alone.)
describe("a recorded kill raises one toast", () => {
  test("no surface adds its own toast right after a kill call", () => {
    const out = Bun.spawnSync(["git", "grep", "-lE", "(killManyWithNotice|killWithNotice|animatedHideSessions)\\(", "--", "app", "components", "hooks"], { cwd: ROOT });
    const files = out.stdout.toString().split("\n").filter((f) => f && !/(__tests__|\.test\.tsx?$)/.test(f));
    expect(files.length).toBeGreaterThan(2);
    const offenders: string[] = [];
    for (const rel of files) {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/(killManyWithNotice|killWithNotice|animatedHideSessions)\([^)]/.test(line)) return;
        const after = lines.slice(i + 1, i + 4).join("\n");
        if (/toast\.success\(/.test(after)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  }, 60_000);
});
