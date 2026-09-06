import { existsSync, renameSync, writeFileSync } from "node:fs";
import { codexQueuedPane } from "./codexQueuedPane.js";

const [statePath, finishPath, layout] = process.argv.slice(2);
const state = { active: true, interrupts: 0, queued: ["Existing worker report."], delivered: [] as string[] };
let composer = "";
let input = "";

function render() {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
  renameSync(`${statePath}.tmp`, statePath);
  const prompt = composer || "Ask Codex to do anything";
  const pane = state.active
    ? layout === "clipped"
      ? `    Existing queued report …\n\n› ${prompt}\n\n  gpt-6-astra xhigh · /tmp`
      : codexQueuedPane(prompt, state.queued.flatMap((message) => message.split("\n")))
    : `• Completed turn.\n\n› ${prompt}\n\n  gpt-6-astra xhigh · /tmp`;
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
      composer += input.slice(6, end).replace(/\r\n?/g, "\n");
      input = input.slice(end + 6);
    } else {
      if (input.startsWith("\x1b") && "\x1b[200~".startsWith(input) && input.length > 1) break;
      const key = input[0];
      input = input.slice(1);
      if (key === "\x1b") {
        state.interrupts++;
        state.active = false;
      } else if (key === "\r" || key === "\n") {
        if (composer) (state.active ? state.queued : state.delivered).push(composer);
        composer = "";
      } else if (key === "\x0b" || key === "\x15") {
        composer = "";
      } else if (key === "\x7f") {
        composer = composer.slice(0, -1);
      } else if (key !== "\x01") {
        composer += key;
      }
    }
    render();
  }
});
setInterval(() => {
  if (state.active && existsSync(finishPath)) {
    state.delivered.push(...state.queued);
    state.queued = [];
    state.active = false;
    render();
  }
}, 50);
render();
