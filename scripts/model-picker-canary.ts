// Model-picker canary: drives the REAL installed Claude Code through a full
// set of in-place model switches and fails loudly if any part of the picker
// contract drifted (a CC update changing the menu layout, hotkeys, effort
// ladder, commit echo wording, or slash-command popup behavior).
//
// The daemon's driver is closed-loop against the live pane, so it absorbs row
// and label changes — what it CANNOT absorb is semantic drift (e.g. `s` no
// longer meaning "this session only"). This canary is how that gets caught the
// day a CC update lands instead of when a user's switch silently fails
// (2026-07-30: four such regressions shipped in CC 2.1.220 unnoticed).
//
// Run:  bun scripts/model-picker-canary.ts
// Cost: spawns one throwaway `claude` TUI session in a scratch tmux pane
// (uses the logged-in account) and performs three session-only switches:
// single switch with effort, then two CONCURRENT switches (the double-command
// race), covering serialization, stranded-Enter recovery, echo counting, and
// the effort-unsupported row (Haiku).

import { driveModelPicker } from "../packages/cli/src/daemon.js";
import { execFileSync } from "node:child_process";

const SESSION = "model-picker-canary";
const TARGET = `${SESSION}:0.0`;
const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" });

const dumpPane = (label: string) => {
  const pane = tmux("capture-pane", "-p", "-J", "-t", TARGET, "-S", "-45")
    .split("\n").filter((l) => l.trim() !== "").join("\n");
  console.log(`--- pane @ ${label} ---\n${pane}\n---`);
};

async function main() {
  try { tmux("kill-session", "-t", SESSION); } catch {}
  tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50");
  tmux("send-keys", "-t", TARGET, "claude", "Enter");

  const start = Date.now();
  while (Date.now() - start < 20000) {
    const pane = tmux("capture-pane", "-p", "-J", "-t", TARGET, "-S", "-15");
    if (/[❯›]/.test(pane) && /shift\+tab to cycle|\/rc/.test(pane)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Let CC finish booting — the slash-command popup races the skills scan.
  await new Promise((r) => setTimeout(r, 2000));

  let failed = false;

  console.log("phase 1: single switch (sonnet + low effort)");
  try {
    console.log("  OK:", await driveModelPicker(TARGET, { menuMatch: "^Sonnet(?!\\s*\\(1M)", effort: "low" }));
  } catch (e) {
    failed = true;
    console.log("  FAIL:", String(e));
    dumpPane("phase 1");
  }

  console.log("phase 2: concurrent switches (opus | haiku + max)");
  const [a, b] = await Promise.allSettled([
    driveModelPicker(TARGET, { menuMatch: "^Opus\\b" }),
    driveModelPicker(TARGET, { menuMatch: "^Haiku\\b", effort: "max" }),
  ]);
  for (const [name, r] of [["opus", a], ["haiku+max", b]] as const) {
    if (r.status === "fulfilled") console.log(`  OK (${name}):`, r.value);
    else { failed = true; console.log(`  FAIL (${name}):`, String(r.reason)); }
  }
  if (failed) dumpPane("phase 2");

  const transcript = tmux("capture-pane", "-p", "-J", "-t", TARGET, "-S", "-120");
  console.log("commit echoes:", JSON.stringify(transcript.match(/Set model to [^\n]*/g) ?? [], null, 2));

  try { tmux("kill-session", "-t", SESSION); } catch {}
  console.log(failed ? "CANARY FAIL" : "CANARY PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("CANARY ERROR:", e);
  try { execFileSync("tmux", ["kill-session", "-t", SESSION]); } catch {}
  process.exit(1);
});
