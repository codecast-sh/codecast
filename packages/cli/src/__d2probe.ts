// Scratch measurement for ct-49538 (deleted before the task closes).
//
// Per client: spawn a cold pane through the matrix recipe and poll the pane the
// way tryStartedTmux polls it, recording for every tick the current
// classifyStartedPane verdict, tmux's #{alternate_on} / #{cursor_flag}, and
// whether each candidate marker is on screen. Then inject at the moment the
// CURRENT rule first says ready and report whether the payload landed.
import "./test-helpers/isolatedTmuxServer.js";
import { spawnClientPane, startFakeModelEndpoint, matrixClientAvailable, MATRIX_CLIENTS, type MatrixClientId } from "./test-helpers/messagingHarness.js";
import { classifyStartedPane, injectViaTmux } from "./daemon.js";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";
import { tmuxRun } from "./tmux.js";
import { randomUUID } from "node:crypto";

const which = (process.argv[2] as MatrixClientId) ?? "codex";
const mode = process.argv[3] ?? "timeline"; // timeline | deliver-at-ready

const flags = (target: string): { alt: boolean; cursor: boolean } => {
  const out = tmuxRun(["display-message", "-p", "-t", target, "-F", "#{alternate_on},#{cursor_flag}"]).stdout.trim();
  const [alt, cursor] = out.split(",");
  return { alt: alt === "1", cursor: cursor === "1" };
};

const MARKERS: Record<string, RegExp> = {
  legacy_claude: /❯|⏵/,
  legacy_codex: />\s*$/,
  legacy_grok: /❯/,
  legacy_opencode: /ctrl\+p commands|Ask anything/i,
  glyph_codex: /›/,
  glyph_grok: /❯/,
};

async function run(client: MatrixClientId): Promise<void> {
  if (!matrixClientAvailable(client)) { console.log(`[probe] ${client} SKIP (binary missing)`); return; }
  const endpoint = await startFakeModelEndpoint();
  const pane = spawnClientPane(client, { endpointUrl: endpoint.url });
  const pattern = AGENT_CLIENTS[client as AgentClientId].promptReadyPattern;
  const firsts: Record<string, number> = {};
  let legacyReadyAt = -1;
  try {
    const deadline = Date.now() + 40_000;
    const tick = Number(process.env.PROBE_TICK_MS ?? 250);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, tick));
      const capture = pane.capture();
      const f = flags(pane.target);
      const state = classifyStartedPane(capture, pattern);
      const age = pane.ageMs();
      if (f.alt && firsts.alt === undefined) firsts.alt = age;
      if (f.cursor && firsts.cursor === undefined) firsts.cursor = age;
      if (!f.alt && firsts.alt_off_after === undefined && firsts.alt !== undefined) firsts.alt_off_after = age;
      if (!f.cursor && firsts.cursor_off === undefined) firsts.cursor_off = age;
      for (const [name, re] of Object.entries(MARKERS)) {
        if (firsts[name] === undefined && re.test(capture)) firsts[name] = age;
      }
      if (state === "ready" && legacyReadyAt < 0) {
        legacyReadyAt = age;
        if (mode === "deliver-at-ready") break;
      }
      if (legacyReadyAt >= 0 && age > legacyReadyAt + 8_000) break;
    }
    console.log(`[probe] client=${client} legacy_ready_ms=${legacyReadyAt} ${Object.entries(firsts).map(([k, v]) => `${k}_ms=${v}`).join(" ")}`);

    if (mode === "deliver-at-ready") {
      const payload = `probe-${randomUUID().slice(0, 8)}: first line\nsecond line\n\nfourth after a blank line`;
      const startedAt = Date.now();
      let err = "";
      try {
        await injectViaTmux(pane.target, payload, client as AgentClientId);
      } catch (e) { err = e instanceof Error ? e.message : String(e); }
      const injectMs = Date.now() - startedAt;
      let landed = false;
      const untilLanded = Date.now() + 45_000;
      while (Date.now() < untilLanded) {
        if (pane.userMessages().some((m) => m.trimEnd() === payload)) { landed = true; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      console.log(`[probe] client=${client} injected_at_ms=${legacyReadyAt} inject_ms=${injectMs} landed=${landed} err=${JSON.stringify(err)} recorded=${JSON.stringify(pane.userMessages())}`);
      console.log(`[probe] pane:\n${pane.capture()}`);
    }
  } finally {
    try { pane.tearDown(); } catch {}
    endpoint.close();
  }
}

const targets = which === "all" ? MATRIX_CLIENTS : [which];
for (const c of targets) await run(c);
process.exit(0);
