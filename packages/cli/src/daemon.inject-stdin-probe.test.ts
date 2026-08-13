import { describe, expect, test } from "bun:test";
import { drainTmuxComposer, proveTmuxStdinConsumption } from "./daemon.js";

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
  test("returns the pre-probe baseline when the composer consumes the first probe", async () => {
    const { exec, sends } = scriptedExec({ consumingAfterPolls: 0 });
    const baseline = await proveTmuxStdinConsumption("t:0.0", 20_000, exec as any);
    expect(sends.length).toBe(1); // one probe, seen immediately
    expect(baseline).toBe(0); // empty composer before the probe
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
    // Returns null (no probe typed, nothing for the drain to verify).
    expect(await proveTmuxStdinConsumption("t:0.0", 20_000, exec as any)).toBeNull();
  });

  test("returns the stale-draft probe count as the baseline", async () => {
    // A draft like "quick fix" sits in the composer before the probe. The
    // baseline must include its 'q' so the drain verifies against it, not 0.
    let composer = "quick fix";
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX(composer) };
      if (args[0] === "send-keys" && args.includes("-l")) composer += args[args.indexOf("-l") + 1];
      return { stdout: "" };
    };
    expect(await proveTmuxStdinConsumption("t:0.0", 20_000, exec as any)).toBe(1);
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

// ct-43082: the probe proves keys reach the input handler, NOT that control
// bytes are interpreted yet. On a marginal cold boot the probe renders while
// C-a/C-k are still mishandled, the accumulated probes survive the blind
// drain, and the paste + Enter submits "qqq<message>". drainTmuxComposer
// closes the loop: after the drain cycles it verifies the composer's probe
// count fell back to the pre-probe baseline, re-draining until it does, and
// throws (retryable) instead of pasting into a dirty composer.
//
// Harness: a fake pane whose composer holds probe residue; C-k empties the
// composer only when the scripted TUI "handles" control keys — immediately,
// never, or only after N capture polls.
function drainScriptedExec(opts: {
  composer: string;
  controls: "handled" | "ignored" | { afterPolls: number };
}) {
  let composer = opts.composer;
  let polls = 0;
  const sends: string[] = [];
  const exec = async (args: Args): Promise<{ stdout: string }> => {
    if (args[0] === "capture-pane") {
      polls++;
      return { stdout: BOX(composer) };
    }
    if (args[0] === "send-keys") {
      const key = args[args.length - 1];
      sends.push(key);
      const handled =
        opts.controls === "handled" || (typeof opts.controls === "object" && polls >= opts.controls.afterPolls);
      if (key === "C-k" && handled) composer = "";
    }
    return { stdout: "" };
  };
  return { exec, sends, getComposer: () => composer, getPolls: () => polls };
}

describe("drainTmuxComposer", () => {
  test("clears probe residue and returns when the TUI handles control keys", async () => {
    const { exec, getComposer } = drainScriptedExec({ composer: "qqq", controls: "handled" });
    await drainTmuxComposer("t:0.0", 0, 5_000, exec as any);
    expect(getComposer()).toBe("");
  });

  test("throws AGENT_STDIN_NOT_READY when probes survive a mishandled drain (the qqq leak)", async () => {
    // Before the fix there was no verification: the paste proceeded and Enter
    // submitted "qqq<message>" as the user's message.
    const { exec } = drainScriptedExec({ composer: "qqq", controls: "ignored" });
    await expect(drainTmuxComposer("t:0.0", 0, 800, exec as any)).rejects.toThrow(
      /AGENT_STDIN_NOT_READY/,
    );
  });

  test("re-drains until a slow input handler catches up", async () => {
    // Control keys start working only after 3 capture polls — the closed loop
    // must keep cycling instead of giving up on the first dirty check.
    const { exec, getComposer } = drainScriptedExec({ composer: "qq", controls: { afterPolls: 3 } });
    await drainTmuxComposer("t:0.0", 0, 5_000, exec as any);
    expect(getComposer()).toBe("");
  });

  test("null baseline (busy pane / glyphless client) keeps the blind drain: no verification, no throw", async () => {
    const { exec, sends, getPolls } = drainScriptedExec({ composer: "fresh draft", controls: "ignored" });
    await drainTmuxComposer("t:0.0", null, 800, exec as any);
    expect(sends.filter((k) => k === "C-k").length).toBe(3); // the three blind cycles only
    expect(getPolls()).toBe(0); // no verification captures
  });

  test("probe chars at or below the baseline count as clean", async () => {
    // baseline 1 = a 'q' predating the probe (e.g. footer text on some client);
    // the drain must not demand a count it can never reach.
    const { exec } = drainScriptedExec({ composer: "q", controls: "ignored" });
    await drainTmuxComposer("t:0.0", 1, 800, exec as any);
  });
});
