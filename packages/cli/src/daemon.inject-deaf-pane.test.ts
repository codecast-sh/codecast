import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { describe, expect, test, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmuxRun } from "./tmux.js";
import { awaitTmuxComposerPayload, injectViaTmux } from "./daemon.js";
import { pasteTextIntoPane } from "./tmuxPaste.js";
import {
  hasBinary,
  waitFor,
  spawnClientPane,
  startFakeModelEndpoint,
  sweepStaleSessions,
  MATRIX_TMUX_PREFIX,
} from "./test-helpers/messagingHarness.js";

const CAN_RUN = hasBinary("tmux") && hasBinary("claude");
const CONTROL_BYTE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
// Every tmux call the gate makes passes through here, so the keys it sends
// while the pane is stopped — the ones that can only be stored, never acted on
// — are counted at the source.
let deaf = false;
const keys: string[] = [];
const exec = async (args: string[]) => {
  if (deaf && args[0] === "send-keys") keys.push(args[args.length - 1]);
  return { stdout: tmuxRun(args).stdout ?? "" };
};
const signal = (pid: number, sig: string) => {
  deaf = sig === "STOP";
  try { execFileSync("kill", [`-${sig}`, String(pid)]); } catch {}
};

describe.skipIf(!CAN_RUN)("the Enter gate waits for a buffered paste without repeating it", () => {
  afterAll(() => {
    sweepStaleSessions(MATRIX_TMUX_PREFIX);
    killIsolatedTmuxServer();
  });

  test.each(["short", "multiline"])("claude records a buffered %s payload once", async (kind) => {
    const endpoint = await startFakeModelEndpoint();
    endpoint.reject(); // every turn ends at once, so the pane stays classifiable
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url });
    const pid = Number(tmuxRun(["display-message", "-p", "-t", pane.target, "#{pane_pid}"]).stdout.trim());
    try {
      await waitFor(() => /❯/.test(pane.capture()), { timeoutMs: 60_000 });

      const payload = kind === "short" ? "continue" : `gatekeys-${randomUUID().slice(0, 8)}: first line\nsecond line\n\nfourth after a blank line`;
      const marker = payload.split(":")[0];
      keys.length = 0;
      let rePastes = 0;
      let gate = "";

      signal(pid, "STOP");
      let wake: ReturnType<typeof setTimeout> | undefined;
      try {
        await pasteTextIntoPane(exec as never, pane.target, payload, true);
        wake = setTimeout(() => signal(pid, "CONT"), 2_500);
        gate = await awaitTmuxComposerPayload(pane.target, payload, {
          bracketedPaste: kind === "multiline",
          prePaste: " never equal to a capture",
          rePaste: async () => { rePastes++; await pasteTextIntoPane(exec as never, pane.target, payload, true); },
          budgetMs: 25_000,
          exec: exec as never,
        });
      } catch (err) {
        gate = "threw " + (err as Error).message.split(":")[0];
      } finally {
        clearTimeout(wake);
        signal(pid, "CONT");
      }
      const keysIntoDeafPane = keys.length;
      if (gate === "matched") tmuxRun(["send-keys", "-t", pane.target, "Enter"]);

      await new Promise((r) => setTimeout(r, 3_000));
      let retry = "not needed";
      if (gate !== "matched") {
        retry = "ok";
        try { await injectViaTmux(pane.target, payload, "claude"); }
        catch (err) { retry = "threw " + (err as Error).message.split(":")[0]; }
      }

      await waitFor(() => pane.userMessages().some((m) => m.includes(marker)), { timeoutMs: 60_000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 3_000));

      const recorded = pane.userMessages().map((m) => m.trimEnd());
      const contaminated = recorded.filter((m) => CONTROL_BYTE.test(m));
      const copies = recorded.reduce((n, m) => n + m.split(marker).length - 1, 0);
      console.log(
        "[probe] gate=" + gate + " rePastes=" + rePastes + " retry=" + retry +
        " keysIntoDeafPane=" + keysIntoDeafPane + " contaminated=" + contaminated.length +
        " copies=" + copies + " recorded=" + JSON.stringify(recorded),
      );
      // The keys are the contamination itself: every one sent into a composer
      // showing nothing is a byte the pane may store and submit as text.
      expect(gate).toBe("matched");
      expect(rePastes).toBe(0);
      expect(keysIntoDeafPane).toBe(0);
      expect(contaminated).toEqual([]);
      expect(copies).toBe(1);
      expect(recorded.filter((m) => m.includes(marker))).toEqual([payload]);
    } finally {
      signal(pid, "CONT");
      try { pane.tearDown(); } catch {}
      endpoint.close();
    }
  }, 240_000);
});
