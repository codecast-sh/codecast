import * as fs from "node:fs";
import * as path from "node:path";
import { capturePane, dismissDialogs, launchClaude, pasteIntoPane, sendKey, sleep, tmux, unplantLogins, waitFor, composerReady, turnRunning } from "./lib/claudeScratch.ts";
import { typeTextIntoPane } from "../src/tmuxPaste.ts";
const run = "/tmp/typed-probe";
const configDir = path.join(run, "config");
const exec = async (args: string[]) => ({ stdout: await tmux(args), stderr: "" });
const long = Array.from({ length: 80 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog, keep this exact text intact please.`).join("\n");
const cases: [string, string, "type" | "paste"][] = [
  ["pastelong", "Reply with only the word ACK.\n" + long, "paste"],
  ["paste3", "Reply with only the word ACK.\nsecond line\nthird line", "paste"],
  ["typelong", "Reply with only the word ACK.\n" + long, "type"],
];
try {
  const pane = await launchClaude("typed-probe", path.join(run, "proj"), configDir, ["--model", "claude-haiku-4-5-20251001", "--setting-sources", "user"]);
  const ready = (p: string) => /^❯/m.test(p) && !/trust this folder/.test(p);
  const first = await waitFor(pane, (p) => /trust this folder/.test(p) || ready(p), 120_000);
  if (first && /trust this folder/.test(first)) { await sendKey(pane, "Down"); await sleep(300); await sendKey(pane, "Enter"); }
  if (!(await waitFor(pane, ready, 120_000))) throw new Error("composer never ready:\n" + await capturePane(pane));
  await sleep(1500);
  for (const [name, text, how] of cases) {
    if (how === "type") await typeTextIntoPane(exec as any, pane, text, "C-j"); else await pasteIntoPane(pane, text);
    await sleep(800);
    console.log(`--- ${name} composer:\n` + (await capturePane(pane)).split("\n").slice(-12).join("\n"));
    await sendKey(pane, "Enter");
    await sleep(3000);
    await waitFor(pane, (p) => /done \d|Worked for/.test(p) && !turnRunning(p), 90_000);
  }
  const files = fs.readdirSync(path.join(configDir, "projects"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(configDir, "projects", f), "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.type !== "user" || typeof r.message?.content !== "string") continue;
      const c: string = r.message.content;
      console.log(`USER len=${c.length} wrapped=${c.includes("<pasted_content")} lines=${c.split("\n").length} intact79=${c.includes("Line 79:")} head=${JSON.stringify(c.slice(0, 70))}`);
    }
  }
} finally {
  try { await tmux(["kill-session", "-t", "typed-probe"]); } catch {}
  unplantLogins();
}
