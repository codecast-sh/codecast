import { expect, test } from "bun:test";
import { awaitTmuxComposerPayload, verifyTmuxSubmitAfterPaste } from "./daemon.js";

const pane = (composer = "", tick = 0) => `${"─".repeat(80)}\n❯ ${composer}\n${"─".repeat(80)}\n  bypass permissions on · ${tick}`;

test("a repainting empty composer waits for the original buffered paste", async () => {
  let polls = 0;
  let rePastes = 0;
  const keys: string[] = [];
  const result = await awaitTmuxComposerPayload("buffered:0.0", "continue", {
    prePaste: pane(),
    rePaste: async () => { rePastes++; },
    exec: async (args) => {
      if (args[0] === "capture-pane") return { stdout: pane(++polls >= 6 ? "continue" : "", polls), stderr: "" };
      if (args[0] === "send-keys") keys.push(args.at(-1)!);
      return { stdout: "", stderr: "" };
    },
  });
  expect(result).toBe("matched");
  expect(rePastes).toBe(0);
  expect(keys).toEqual([]);
}, 30_000);

test("unconfirmed submission does not repeat a paste just because the empty composer repaints", async () => {
  let tick = 0;
  let rePastes = 0;
  let enters = 0;
  const result = await verifyTmuxSubmitAfterPaste({
    capture: async () => pane("", ++tick),
    sendEnter: async () => { enters++; },
    rePaste: async () => { rePastes++; },
    sleep: async () => {},
    log: () => {},
  }, { prePaste: pane(), pasteConfirmed: false, contentPrefix: "continue", deadlineMs: 4_000 });
  expect(result.outcome).toBe("agent_prompt_stalled");
  expect(result.rePasted).toBe(false);
  expect(rePastes).toBe(0);
  expect(enters).toBe(0);
});
