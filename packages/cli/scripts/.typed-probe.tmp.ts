import * as fs from "node:fs";
import * as path from "node:path";
import { capturePane, launchClaude, sendKey, sleep, tmux, unplantLogins, waitFor } from "./lib/claudeScratch.ts";
const run = "/tmp/typed-probe"; const configDir = path.join(run, "config");
const sizes = (process.env.SIZES ?? "64,128,256,512,800,1024").split(",").map(Number);
const msg = (n: number) => `Reply ACK only. size=${n}\n` + Array.from({ length: 40 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog, keep text.`).join("\n");
try {
  const pane = await launchClaude("typed-probe", path.join(run, "proj"), configDir, ["--model", "claude-haiku-4-5-20251001", "--setting-sources", "user"]);
  const ready = (p: string) => /^❯/m.test(p) && !/trust this folder/.test(p);
  const first = await waitFor(pane, (p) => /trust this folder/.test(p) || ready(p), 120_000);
  if (first && /trust this folder/.test(first)) { await sendKey(pane, "Down"); await sleep(300); await sendKey(pane, "Enter"); }
  if (!(await waitFor(pane, ready, 120_000))) throw new Error("not ready");
  await sleep(2000);
  for (const n of sizes) {
    const t = msg(n);
    for (let at = 0; at < t.length; at += n) await tmux(["send-keys", "-t", pane, "-l", "--", t.slice(at, at + n)]);
    await sleep(1500);
    const chip = /\[Pasted text/.test(await capturePane(pane));
    await sendKey(pane, "Enter");
    await sleep(2000);
    await waitFor(pane, (p) => !/esc to interrupt|…\s*\(/.test(p), 90_000);
    await sleep(1000);
    console.log(`size=${n} chipOnScreen=${chip}`);
  }
  for (const f of fs.readdirSync(path.join(configDir, "projects"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")))
    for (const line of fs.readFileSync(path.join(configDir, "projects", f), "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line); const c = r.message?.content;
      if (r.type === "user" && typeof c === "string") console.log(`USER wrapped=${c.includes("<pasted_content")} wrappers=${(c.match(/<pasted_content/g) ?? []).length} ${c.match(/size=\d+/)?.[0]}`);
    }
} finally { try { await tmux(["kill-session", "-t", "typed-probe"]); } catch {} unplantLogins(); }
