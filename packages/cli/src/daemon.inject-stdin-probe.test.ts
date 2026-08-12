import { describe, expect, test } from "bun:test";
import { proveTmuxStdinConsumption } from "./daemon.js";

// ct-40212: a painted composer does not prove stdin is being read. On a cold
// boot under load the ❯ box is visible for seconds while every key still lands
// in a pty buffer the input handler later mishandles — the paste is dropped and
// the C-a/C-k clearing bytes surface as literal text inside a submitted message.
// proveTmuxStdinConsumption gates the paste on a probe key actually rendering in
// the composer region, so a deaf pane stalls the probe (then throws) instead of
// swallowing the real message.
//
// These tests drive the helper with a scripted `exec`: a fake pane whose
// composer echoes probe chars only once "consumption" turns on after N capture
// polls, so the tick-by-tick behavior is deterministic and fast.

type Args = string[];
const BOX = (composer: string) => `
 ▐▛███▜▌   Claude Code v2.1.228
▝▜█████▛▘  Fable 5

────────────────────────────────────────
❯ ${composer}
────────────────────────────────────────
  ⏵⏵ bypass permissions on
`;

// Builds an exec() that models a composer: send-keys -l appends chars to the
// composer line, but only once `consumingAfterPolls` capture polls have elapsed
// (a deaf boot window). Records every send-keys the helper issued.
function scriptedExec(opts: { consumingAfterPolls: number }) {
  let composer = "";
  let pending = ""; // keys sent while still deaf, applied when consumption starts
  let polls = 0;
  const sends: string[] = [];
  const exec = async (args: Args): Promise<{ stdout: string }> => {
    if (args[0] === "capture-pane") {
      polls++;
      // Once consuming, flush any buffered deaf-window keys into the composer.
      if (polls > opts.consumingAfterPolls && pending) {
        composer += pending;
        pending = "";
      }
      return { stdout: BOX(composer) };
    }
    if (args[0] === "send-keys") {
      const li = args.indexOf("-l");
      if (li !== -1) {
        const ch = args[li + 1];
        sends.push(ch);
        if (polls >= opts.consumingAfterPolls) composer += ch; // consuming now
        else pending += ch; // buffered; a real TUI would mishandle these
      }
    }
    return { stdout: "" };
  };
  return { exec, sends, getComposer: () => composer };
}

describe("proveTmuxStdinConsumption", () => {
  test("returns quickly when the composer consumes the first probe", async () => {
    const { exec, sends } = scriptedExec({ consumingAfterPolls: 0 });
    await proveTmuxStdinConsumption("t:0.0", 20_000, exec as any);
    expect(sends.length).toBe(1); // one probe, seen immediately
  });

  test("throws AGENT_STDIN_NOT_READY when the composer never consumes", async () => {
    const { exec, sends } = scriptedExec({ consumingAfterPolls: 10_000 }); // never within budget
    await expect(proveTmuxStdinConsumption("t:0.0", 1_200, exec as any)).rejects.toThrow(
      /AGENT_STDIN_NOT_READY/,
    );
    expect(sends.length).toBeGreaterThan(0); // it did try
  });

  test("waits through a deaf window, then returns once consumption starts", async () => {
    // Deaf for the first 3 capture polls, then the input handler wakes.
    const { exec } = scriptedExec({ consumingAfterPolls: 3 });
    await proveTmuxStdinConsumption("t:0.0", 20_000, exec as any);
    // No throw = success. The buffered deaf-window probes are still in the
    // composer, which the caller's C-a/C-k drain clears before the real paste.
  });

  test("no-op on a glyphless pane (no composer region to watch)", async () => {
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "send-keys") throw new Error("must not type into a glyphless pane");
      return { stdout: "opencode ready\nno prompt glyph here\n" };
    };
    // Returns without sending any key or throwing.
    await proveTmuxStdinConsumption("t:0.0", 20_000, exec as any);
  });

  test("does not count a probe glyph that only appears ABOVE the composer", async () => {
    // A 'q' living in the banner/transcript must not be read as consumption —
    // only the composer region (glyph line and below) counts.
    let polls = 0;
    const sends: string[] = [];
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") {
        polls++;
        // Transcript line contains 'q' from the start; composer stays empty.
        return { stdout: `\nprevious answer: qed\n────────\n❯ \n────────\n` };
      }
      if (args[0] === "send-keys" && args.includes("-l")) sends.push(args[args.indexOf("-l") + 1]);
      return { stdout: "" };
    };
    await expect(proveTmuxStdinConsumption("t:0.0", 1_000, exec as any)).rejects.toThrow(
      /AGENT_STDIN_NOT_READY/,
    );
    expect(sends.length).toBeGreaterThan(0);
  });
});
