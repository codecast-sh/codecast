// Tier 2: cold-resume robustness.
//   2a) resumeReadinessPollMs — readiness window scales with JSONL size; the floor
//       was raised 15s -> 30s so a from-scratch (reconstituted) boot has room to
//       render its prompt before the optimistic inject.
//   2b) a resume that drops to a bare shell must be recognized as "exited" so the
//       poll aborts fast (transient) instead of pasting into a dead shell — the
//       SESSION_EXITED failure that snowballed into the 19-min outage.
//
// Imports daemon.ts directly to bypass the stale committed daemon.js bundle.
import { test, expect } from "bun:test";
import {
  resumeReadinessPollMs,
  classifyTmuxLiveState,
  extractTmuxLiveRegion,
} from "./daemon.ts";

// ---- 2a: readiness window tiers ----
test("readiness floor is 30s for small/reconstituted sessions (was 15s)", () => {
  expect(resumeReadinessPollMs(0)).toBe(30_000);
  expect(resumeReadinessPollMs(500_000)).toBe(30_000);
  expect(resumeReadinessPollMs(1_000_000)).toBe(30_000); // boundary: not > 1MB
});

test("readiness window scales up for larger transcripts", () => {
  expect(resumeReadinessPollMs(1_000_001)).toBe(45_000);
  expect(resumeReadinessPollMs(5_000_000)).toBe(45_000);
  expect(resumeReadinessPollMs(10_000_001)).toBe(90_000);
  expect(resumeReadinessPollMs(50_000_000)).toBe(90_000);
});

// ---- 2b: bare-shell detection ----
const classify = (pane: string) => classifyTmuxLiveState(extractTmuxLiveRegion(pane));

test("a resume that exited to a bare shell classifies as 'exited' (fast-fail trigger)", () => {
  // What Claude prints when the session ends / a resume bails back to the shell.
  const pane = [
    "Total cost:            $1.23",
    "Total duration (API):  2m 1s",
    "",
    "Resume this session with: claude --resume 4958b319-906c-47a9-acc2-e389c8d52bdc",
    "",
    "ashot@mac codecast %",
  ].join("\n");
  expect(classify(pane)).toBe("exited");
});

test("a failed launch (shell command-not-found) classifies as 'exited'", () => {
  const pane = ["ashot@mac codecast % claude --resume abc", "-bash: claude: command not found", "ashot@mac codecast %"].join("\n");
  expect(classify(pane)).toBe("exited");
});

test("the resume command line typed at boot does NOT false-trigger 'exited'", () => {
  // First poll iterations: the command we just sent is on screen, agent still booting.
  // Must NOT be treated as exited, or we'd abort every cold boot before it starts.
  const pane = [
    "ashot@mac codecast %  CLAUDECODE= claude --resume 4958b319 --dangerously-skip-permissions --chrome",
    "",
    "Loading…",
  ].join("\n");
  expect(classify(pane)).not.toBe("exited");
});

test("a live Claude TUI prompt does NOT classify as 'exited'", () => {
  const pane = [
    "  Some assistant output above",
    "────────────────────────────────────────────────",
    "❯                                                ",
    "────────────────────────────────────────────────",
    "  ? for shortcuts",
  ].join("\n");
  expect(classify(pane)).not.toBe("exited");
});
