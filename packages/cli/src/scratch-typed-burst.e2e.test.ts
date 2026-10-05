import "./test-helpers/isolatedTmuxServer.js";
import { afterAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { typeTextIntoPane } from "./tmuxPaste.js";
import { tmuxRunAsync } from "./tmux.js";
const tmuxExec = async (args: string[]) => { const r = await tmuxRunAsync(args); if (r.status !== 0) throw new Error(r.stderr); return r; };
import { spawnClientPane, startFakeModelEndpoint, waitFor } from "./test-helpers/messagingHarness.js";
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";

afterAll(() => killIsolatedTmuxServer());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

import { readFileSync } from "node:fs";
const realPayload = process.env.REAL ? readFileSync("/tmp/pearl-stuck.txt", "utf8") : null;
const synthetic = ["<session-message from=\"unknown\">", "Huddle (live), where you are Pearl."]
  .concat(Array.from({ length: 78 }, (_, i) => `  **Speaker ${i % 3}**: line ${i} of the room talking about the desk and the broker, and whether the callers should join first instead of spreading it over the surface.`))
  .concat(["</session-message>"]).join("\n");
const payload = realPayload ?? synthetic;

for (const mode of (process.env.MODES ?? "stopped,live").split(",")) {
  test(`typed burst ${mode}`, async () => {
    const endpoint = await startFakeModelEndpoint();
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url, machineFeatures: true, tui: process.env.TUI === "fullscreen" ? "fullscreen" : undefined });
    try {
      await waitFor(() => pane.liveState() === "idle", 60_000);
      await sleep(1500);
      const pid = (await tmuxExec(["list-panes", "-t", pane.target, "-F", "#{pane_pid}"])).stdout.trim();
      console.log('pid', pid, execSync(`ps -o pid,command -p ${pid}`).toString().slice(0, 200));
      if (mode === "stopped") execSync(`kill -STOP ${pid}`);
      let flapping = mode === "flap";
      const flap = (async () => { while (flapping) { execSync(`kill -STOP ${pid}`); await sleep(150 + Math.random() * 400); execSync(`kill -CONT ${pid}`); await sleep(20 + Math.random() * 60); } })();
      await typeTextIntoPane(tmuxExec, pane.target, payload, "C-j");
      flapping = false; await flap;
      if (mode === "stopped") { await sleep(2000); execSync(`kill -CONT ${pid}`); }
      await sleep(4000);
      await tmuxExec(["send-keys", "-t", pane.target, "Enter"]);
      await sleep(6000);
      const users = pane.userMessages();
      const norm = (t: string) => t.replace(/\s+/g, " ").trim();
      console.log(`[${mode}] users=${users.length} sentLen=${payload.length} gotLen=${users[0]?.length} exact=${users[0] !== undefined && norm(users[0]).includes(norm(payload))} wrapped=${users[0]?.includes("pasted_content")}`);
      console.log(pane.capture().split("\n").filter((l) => l.trim()).slice(-6).join("\n"));
      if (users.length === 0) {
        const full = (await tmuxExec(["capture-pane", "-p", "-J", "-t", pane.target, "-S", "-400"])).stdout;
        const lines = payload.split("\n").map((l) => l.trim()).filter(Boolean);
        const missing = lines.filter((l) => !norm(full).includes(norm(l).slice(0, 60)));
        console.log(`  missing ${missing.length}/${lines.length} lines; first missing: ${JSON.stringify(missing[0]?.slice(0, 80))}`);
        await tmuxExec(["send-keys", "-t", pane.target, "Enter"]); await sleep(5000);
        console.log(`  after 2nd Enter users=${pane.userMessages().length}`);
        await tmuxExec(["send-keys", "-t", pane.target, "-l", "\x1b[201~"]); await sleep(1000);
        await tmuxExec(["send-keys", "-t", pane.target, "Enter"]); await sleep(6000);
        const after = pane.userMessages();
        console.log(`  after paste-end+Enter users=${after.length} gotLen=${after[0]?.length} exact=${after[0] !== undefined && norm(after[0]).includes(norm(payload))} wrapped=${after[0]?.includes("pasted_content")}`);
      }
      expect(users.length).toBe(1);
    } finally {
      pane.tearDown();
      endpoint.close?.();
    }
  }, 120_000);
}
