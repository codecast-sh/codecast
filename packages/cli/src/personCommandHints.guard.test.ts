import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Agents repeat what the CLI and its guides tell them. Text that sends a
// person to a terminal ("run this in a terminal there", "their own
// terminal") reaches the person as a command to type, where the app should
// show a Yes card (`cast decide --run`, askToRun) or a setup card. This scan
// fails on that wording in agent-facing source.

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCANNED = ["packages/cli/src", "packages/shared/contracts", "packages/convex/convex"];

const TERMINAL_HANDOFF =
  /\b(in|from) (a|your|their) (own )?terminal\b|\b(your|their) own terminal\b|\bin a terminal there\b|\btype (this|it) in\b|\b(have (them|the human|your person) run|ask (the human|your person|them) to run) [`'\"]|\bpaste (this|it) into (a|your|their) terminal\b/i;

// Each entry is a real gap with no in-app path yet, never a convenience.
const ALLOWED: Array<{ file: string; text: string; why: string }> = [
  { file: "packages/cli/src/daemon.ts", text: "has no browser to finish the sign-in. In a terminal there", why: "Claude sign-in on a cloud host with no headless login: no in-app path yet" },
  { file: "packages/cli/src/daemon.ts", text: "run `claude auth login` in a terminal to change the machine's own login", why: "Claude Code's own login on a build that ignores per-account stores: no in-app path yet" },
  { file: "packages/shared/contracts/snippets.ts", text: "after you approve it in your own terminal", why: "mods approve their local half in a terminal today: no in-app path yet" },
  { file: "packages/cli/src/claudeSdk/switchBackend.ts", text: "Claude did not start in a terminal", why: "names the backend, not a person's step" },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "_generated" || entry.name.startsWith("__")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("agent-facing text never sends a person to a terminal", () => {
  test("no terminal handoff outside the allowlist", () => {
    const hits: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sources(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file);
        fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line) || !TERMINAL_HANDOFF.test(line)) return;
          if (ALLOWED.some((a) => a.file === rel && line.includes(a.text))) return;
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
      }
    }
    expect(hits, "Give the agent a Yes card (askToRun / cast decide --run) or a setup card instead of a command for the person to type").toEqual([]);
  });

  test("catches the wording that reached a person before", () => {
    for (const shipped of [
      "and only they start it (the Vault page's Save sign-in, or their own terminal): an agent session is refused",
      "Chrome's cookies are locked behind the login Keychain on this Mac: run cast vault save-signin x --from-chrome once in a terminal there",
      "press Save sign-in on the Vault page and pick this laptop, or run it in your own terminal.",
    ]) expect(TERMINAL_HANDOFF.test(shipped)).toBe(true);
  });

  test("every allowlist entry still matches, so a fixed gap leaves the list", () => {
    for (const a of ALLOWED) expect(fs.readFileSync(path.join(ROOT, a.file), "utf8")).toContain(a.text);
  });
});
