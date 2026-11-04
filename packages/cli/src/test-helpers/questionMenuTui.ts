// A Claude Code AskUserQuestion menu in a terminal, for delivery tests. It
// records what reached it: Escape declines the menu and opens the composer,
// typed or pasted text fills the composer, Enter submits it (or, while the
// menu is up, picks the highlighted option).
import { renameSync, writeFileSync } from "node:fs";

const [statePath] = process.argv.slice(2);
const state = { menuOpen: true, declined: 0, picked: [] as string[], delivered: [] as string[] };
let composer = "";
let input = "";

const MENU = [
  "By \"Two\", did you mean the second change (the slow-test tier) or a cap of two full test suites at once?",
  "",
  "❯ 1. Cap at 2 full suites",
  "     Allow at most two full test suites at once across the machine.",
  "  2. Only the slow-test tier",
  "     Do just change 2.",
  "  3. Both: cap 2 + slow tier",
  "     Cap full suites at two at once, and build the slow-test tier.",
  "  4. Type something.",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

function render() {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
  renameSync(`${statePath}.tmp`, statePath);
  const pane = state.menuOpen ? MENU : `${"─".repeat(80)}\n❯ ${composer}\n${"─".repeat(80)}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;
  process.stdout.write(`\x1b[2J\x1b[H${pane.replace(/\n/g, "\r\n")}`);
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  while (input.length) {
    if (input.startsWith("\x1b[200~")) {
      const end = input.indexOf("\x1b[201~", 6);
      if (end === -1) break;
      if (!state.menuOpen) composer += input.slice(6, end);
      input = input.slice(end + 6);
      continue;
    }
    if (input.startsWith("\x1b") && "\x1b[200~".startsWith(input) && input.length > 1) break;
    const key = input[0];
    input = input.slice(1);
    if (key === "\x1b") {
      if (state.menuOpen) { state.menuOpen = false; state.declined++; }
    } else if (key === "\r" || key === "\n") {
      if (state.menuOpen) { state.picked.push("1"); state.menuOpen = false; }
      else if (composer) { state.delivered.push(composer); composer = ""; }
    } else if (state.menuOpen) {
      if (/[1-4]/.test(key)) { state.picked.push(key); state.menuOpen = false; }
    } else if (key === "\x0b" || key === "\x15") {
      composer = "";
    } else if (key === "\x7f") {
      composer = composer.slice(0, -1);
    } else if (key !== "\x01") {
      composer += key;
    }
  }
  render();
});
render();
