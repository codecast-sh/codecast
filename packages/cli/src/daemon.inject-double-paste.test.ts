// ct-49753 / ct-49841: a composer that already holds two copies must never be
// submitted as it stands, not by the Enter gate and not by the pre-paste check
// that can reach Enter without ever consulting the gate.
//
// The gate's re-paste branch used to claim a doubled message was impossible by
// construction, because C-a/C-k rode the pty stream ahead of every re-paste and
// wiped a late flush of the first copy. Claude holding the composer in
// history-recall mode does not act on those keys, so the re-paste landed on top
// of a first copy that was already in the box, and the old prefix match — which
// only ever looked at what came BEFORE the payload — accepted "payloadpayload"
// and pressed Enter. The field transcript recorded
// "follow-up content 67cd3ebdfollow-up content 67cd3ebd".
//
// That sequence needs the gate's re-paste branch to fire on a recalled draft,
// which happened once in 18 runs of the inject-clear test. So this forces the
// state the branch produces instead of waiting for the branch: paste the
// payload twice into a live claude composer, then hand that composer to the
// gate. What the gate does next is the whole fix.
//
//   before  the prefix matches, the gate returns "matched" over two copies, and
//           the Enter that follows submits the message twice.
//   after   two copies fail the match, so the gate drains (the composer visibly
//           holds text, so claude acts on the keys) and re-pastes, and the
//           message is recorded once.
//
// The payload is single-line, which is both what the field case carried
// ("follow-up content 67cd3ebd") and what claude draws as text at the prompt,
// so this exercises the prefix count. The other match path — two collapsed
// "[Pasted text #N]" chips — is covered by daemon.inject-enter-gate.test.ts
// against a captured claude composer, because whether a build collapses a given
// paste at all depends on its own threshold and cannot be forced from here.
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { describe, expect, test, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
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
const exec = async (args: string[]) => ({ stdout: tmuxRun(args).stdout ?? "" });

describe.skipIf(!CAN_RUN)("a claude composer holding two copies is never submitted twice", () => {
  afterAll(() => {
    sweepStaleSessions(MATRIX_TMUX_PREFIX);
    killIsolatedTmuxServer();
  });

  test("a single-line payload at the prompt twice is not submitted twice", async () => {
    const payload = `double-${randomUUID().slice(0, 8)}: follow-up content`;
    const marker = payload.split(":")[0];
    const endpoint = await startFakeModelEndpoint();
    endpoint.reject(); // every turn ends at once, so the pane stays classifiable
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url });
    try {
      await waitFor(() => /❯/.test(pane.capture()), { timeoutMs: 60_000, label: "claude prompt" });

      // The state the re-paste branch leaves behind on a composer that took the
      // first paste: two copies, one after the other, nothing else.
      await pasteTextIntoPane(exec as never, pane.target, payload, true);
      await waitFor(() => pane.capture().includes(marker), { timeoutMs: 20_000, label: "first paste at the prompt" });
      await pasteTextIntoPane(exec as never, pane.target, payload, true);
      await waitFor(() => pane.capture().split(marker).length - 1 >= 2,
        { timeoutMs: 20_000, label: "two copies at the prompt" });

      let rePastes = 0;
      let gate = "";
      try {
        gate = await awaitTmuxComposerPayload(pane.target, payload, {
          // Never equal to a capture, so the frozen-pane branch cannot fire and
          // the gate has to decide on what the composer shows.
          prePaste: " never equal to a capture",
          rePaste: async () => {
            rePastes++;
            await pasteTextIntoPane(exec as never, pane.target, payload, true);
          },
          budgetMs: 25_000,
          exec: exec as never,
        });
      } catch (err) {
        gate = "threw " + (err as Error).message.split(":")[0];
      }
      if (gate === "matched") tmuxRun(["send-keys", "-t", pane.target, "Enter"]);

      // Not every good outcome records a message: when the gate refuses and the
      // composer still will not converge it throws, and nothing is submitted.
      await waitFor(() => pane.userMessages().some((m) => m.includes(marker)), { timeoutMs: 60_000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 3_000));

      const recorded = pane.userMessages().map((m) => m.trimEnd());
      const copies = recorded.reduce((n, m) => n + m.split(marker).length - 1, 0);
      console.log(
        `[double] gate=${gate} rePastes=${rePastes} copies=${copies} ` +
        `recorded=${JSON.stringify(recorded)}`,
      );

      // Accepting the composer as it stands is the bug: "matched" with nothing
      // re-pasted means the gate read two copies and called them the payload.
      // Refusing and re-pasting is the good outcome; throwing
      // AGENT_STDIN_NOT_READY is the acceptable one, because the delivery layer
      // then redelivers rather than sending the message twice.
      expect(gate === "matched" && rePastes === 0, JSON.stringify(recorded)).toBe(false);
      expect(copies, `recorded: ${JSON.stringify(recorded)}`).toBeLessThanOrEqual(1);
    } finally {
      try { pane.tearDown(); } catch {}
      endpoint.close();
    }
  }, 240_000);

  // ct-49841: the same composer, handed to the WHOLE injection path rather than
  // to the gate alone. injectViaTmux asks before it pastes whether the payload
  // is already at the prompt, and a "yes" skips the drain and the paste and
  // presses Enter over what is there. Reading two copies as "already there" is
  // how the union of the two fixes reopened the doubling: the gate refused the
  // doubled composer, and the check in front of it never let the gate see it.
  test("a composer already holding two copies is not submitted as one message", async () => {
    const payload = `union-${randomUUID().slice(0, 8)}: follow-up content`;
    const marker = payload.split(":")[0];
    const endpoint = await startFakeModelEndpoint();
    endpoint.reject();
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url });
    try {
      await waitFor(() => /❯/.test(pane.capture()), { timeoutMs: 60_000, label: "claude prompt" });

      await pasteTextIntoPane(exec as never, pane.target, payload, true);
      await waitFor(() => pane.capture().includes(marker), { timeoutMs: 20_000, label: "first paste at the prompt" });
      await pasteTextIntoPane(exec as never, pane.target, payload, true);
      await waitFor(() => pane.capture().split(marker).length - 1 >= 2,
        { timeoutMs: 20_000, label: "two copies at the prompt" });

      let outcome = "delivered";
      try {
        await injectViaTmux(pane.target, payload, "claude");
      } catch (err) {
        outcome = (err as Error).message.split(":")[0];
      }

      await waitFor(() => pane.userMessages().some((m) => m.includes(marker)), { timeoutMs: 60_000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 3_000));

      const recorded = pane.userMessages().map((m) => m.trimEnd());
      const copies = recorded.reduce((n, m) => n + m.split(marker).length - 1, 0);
      console.log(`[double/inject] outcome=${outcome} copies=${copies} recorded=${JSON.stringify(recorded)}`);

      // One message, or none with AGENT_STDIN_NOT_READY left for the delivery
      // layer to retry. Two copies of the marker, in one message or across two,
      // is the bug whichever way they were submitted.
      expect(["delivered", "AGENT_STDIN_NOT_READY"]).toContain(outcome);
      expect(copies, `recorded: ${JSON.stringify(recorded)}`).toBeLessThanOrEqual(1);
    } finally {
      try { pane.tearDown(); } catch {}
      endpoint.close();
    }
  }, 240_000);
});
