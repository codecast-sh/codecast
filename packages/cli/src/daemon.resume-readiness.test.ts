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
  MAX_RESUME_READINESS_POLL_MS,
  RESUME_IN_FLIGHT_TIMEOUT_MS,
  classifyTmuxLiveState,
  extractTmuxLiveRegion,
} from "./daemon.js";

// ---- 2a: readiness window tiers ----
test("readiness floor is 30s for small/reconstituted sessions (was 15s)", () => {
  expect(resumeReadinessPollMs(0)).toBe(30_000);
  expect(resumeReadinessPollMs(500_000)).toBe(30_000); // boundary: not > 500KB
});

test("readiness window scales up for larger transcripts", () => {
  expect(resumeReadinessPollMs(500_001)).toBe(60_000);
  expect(resumeReadinessPollMs(1_000_001)).toBe(90_000);
  expect(resumeReadinessPollMs(10_000_001)).toBe(120_000);
  expect(resumeReadinessPollMs(50_000_000)).toBe(120_000);
});

// jx78ksdh85pw: an 880KB transcript took Claude 38-71s to render its prompt, but
// the old 1MB boundary gave it the 30s tier — so every restart of that session
// reported a timeout on a boot that was actually fine, and the web sat on
// "resuming" while the user clicked Restart again and killed the healthy pane.
test("a ~900KB transcript gets a window Claude can actually boot in", () => {
  expect(resumeReadinessPollMs(901_411)).toBeGreaterThanOrEqual(60_000);
});

test("no tier exceeds the declared ceiling", () => {
  for (const size of [0, 500_001, 1_000_001, 10_000_001, 500_000_000]) {
    expect(resumeReadinessPollMs(size)).toBeLessThanOrEqual(MAX_RESUME_READINESS_POLL_MS);
  }
});

// ---- 2c: the guard must outlive the thing it guards ----
// The in-flight map is what serializes resumes on one session. When it expires
// mid-resume it does not merely retry — it lets a SECOND resume run against the
// same tmux name, which is how `duplicate session: cc-resume-c731de13` appeared
// with two `claude --resume` lines typed into one pane. Any future tier bump that
// crosses the guard re-opens that window, so pin the ordering here.
test("the in-flight guard outlives the longest readiness window", () => {
  expect(RESUME_IN_FLIGHT_TIMEOUT_MS).toBeGreaterThan(MAX_RESUME_READINESS_POLL_MS);
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
