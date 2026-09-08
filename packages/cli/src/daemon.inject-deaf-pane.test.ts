// ct-49750: the Enter gate must not type into a composer that shows nothing.
//
// The gate's re-paste branch used to clear the composer with C-a/C-k before
// every second paste. On a pane that has painted its box but is not reading
// stdin those keys are stored, not acted on, and claude draws them as nothing —
// so the gate reads a clean composer, presses Enter, and the message arrives as
// "\v\x01\v\x01\v<payload>" (cold_boot_clearing_keys_land_as_text). The field
// case carried six such pairs, two drains' worth.
//
// The defect needs three things at once, and none of them happens on demand:
// the branch fired 0 times in 36 baseline matrix cells on this machine. So this
// forces all three.
//
//   deaf pane      SIGSTOP on the claude process. Everything tmux sends then
//                  sits in the pty until SIGCONT.
//   empty branch   `prePaste` is a string no capture can equal, so the gate's
//                  frozen-pane check (which SIGSTOP would otherwise trip)
//                  cannot fire and the live-empty branch runs on tick three.
//   the wake       SIGCONT lands 2.5s in, inside the gate's budget, so claude
//                  drains the buffer and paints the payload while the gate is
//                  still watching — which is when the bad Enter goes.
//
// The load-bearing assertion is the key count: keys sent while the pane is
// stopped can only be stored, so zero of them is the fix. The old code sends 9
// here (three C-a/C-k/BSpace cycles) in every run. The other two assertions say
// the delivery still works — the message lands once, with nothing glued to it —
// and both held before and after, so they bound the change rather than prove
// it. When the gate refuses to submit instead, the delivery layer's own retry
// finishes the job, which is allowed to be slower but must still be correct.
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

describe.skipIf(!CAN_RUN)("the Enter gate re-pastes over a deaf claude pane without typing into it", () => {
  afterAll(() => {
    sweepStaleSessions(MATRIX_TMUX_PREFIX);
    killIsolatedTmuxServer();
  });

  test("claude records the payload once, with nothing glued to it", async () => {
    const endpoint = await startFakeModelEndpoint();
    endpoint.reject(); // every turn ends at once, so the pane stays classifiable
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url });
    const pid = Number(tmuxRun(["display-message", "-p", "-t", pane.target, "#{pane_pid}"]).stdout.trim());
    try {
      await waitFor(() => /❯/.test(pane.capture()), { timeoutMs: 60_000 });

      const payload = `gatekeys-${randomUUID().slice(0, 8)}: first line\nsecond line\n\nfourth after a blank line`;
      let rePastes = 0;
      let gate = "";

      signal(pid, "STOP");
      const wake = setTimeout(() => signal(pid, "CONT"), 2_500);
      try {
        gate = await awaitTmuxComposerPayload(pane.target, payload, {
          multiline: true,
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

      await waitFor(() => pane.userMessages().some((m) => m.includes("gatekeys-")), { timeoutMs: 60_000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 3_000));

      const recorded = pane.userMessages().map((m) => m.trimEnd());
      const marker = payload.split(":")[0];
      const contaminated = recorded.filter((m) => CONTROL_BYTE.test(m));
      const copies = recorded.reduce((n, m) => n + m.split(marker).length - 1, 0);
      console.log(
        "[probe] gate=" + gate + " rePastes=" + rePastes + " retry=" + retry +
        " keysIntoDeafPane=" + keysIntoDeafPane + " contaminated=" + contaminated.length +
        " copies=" + copies + " recorded=" + JSON.stringify(recorded),
      );
      // The keys are the contamination itself: every one sent into a composer
      // showing nothing is a byte the pane may store and submit as text.
      expect(keysIntoDeafPane).toBe(0);
      expect(contaminated).toEqual([]);
      expect(copies).toBe(1);
    } finally {
      signal(pid, "CONT");
      try { pane.tearDown(); } catch {}
      endpoint.close();
    }
  }, 240_000);
});
