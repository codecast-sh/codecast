// Clay's loop with scripted model turns (pi-ai's faux provider): the tools
// change the draft, finish gates on validation and feeds problems back, and
// finish or decline settles the build and stops the run at once.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@mariozechner/pi-ai";
import { BUILD_FINISH_ATTEMPTS } from "../lib/limits";
import { seedFiles } from "../lib/seed";
import { runBuilder } from "./agent";
import { Draft } from "./draft";
import { Narration } from "./rules";

let faux: FauxProviderRegistration;
beforeEach(() => {
  faux = registerFauxProvider({ models: [{ id: "claude-sonnet-5-5" }] });
});
afterEach(() => faux.unregister());

let n = 0;
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call_${++n}` })], { stopReason: "toolUse" });

async function build(turns: ReturnType<typeof fauxAssistantMessage>[]) {
  faux.setResponses(turns);
  const draft = new Draft(seedFiles("Tea Tally"));
  const narration = new Narration();
  let steps = 0;
  const run = await runBuilder({
    draft,
    narration,
    prompt: "add a reset button",
    onStep: () => steps++,
    controller: new AbortController(),
    model: faux.getModel(),
  });
  return { ...run, draft, narration, steps, unused: faux.getPendingResponseCount() };
}

const importReset = {
  path: "src/App.jsx",
  old_text: 'import { useState } from "react";',
  new_text: 'import { useState } from "react";\nimport Reset from "./Reset.jsx";',
  about: "Adding a reset button",
};

describe("runBuilder", () => {
  test("finish feeds validation problems back, then commits the fixed draft and stops", async () => {
    const r = await build([
      fauxAssistantMessage([fauxText("Adding a reset button."), fauxToolCall("edit_file", importReset, { id: "e1" })], { stopReason: "toolUse" }),
      call("finish", { summary: "Adds a reset button" }),
      call("write_file", { path: "src/Reset.jsx", content: "export default function Reset() { return <button>Reset</button>; }\n" }),
      call("finish", { summary: "Adds a reset button" }),
      fauxAssistantMessage([fauxText("This turn must never be asked for.")]),
    ]);
    expect(r.outcome).toEqual({ kind: "finished", summary: "Adds a reset button" });
    expect(r.unused).toBe(1);
    expect(r.draft.read("src/Reset.jsx")).toContain("Reset");
    expect(r.draft.touched().filter((t) => t.how !== "read")).toEqual([
      { path: "src/App.jsx", how: "wrote" },
      { path: "src/Reset.jsx", how: "wrote" },
    ]);
    expect(r.narration.view().map((l) => l.text)).toEqual([
      "Adding a reset button.",
      "Adding a reset button",
      "Fixing a problem the check found",
      "Creating Reset.jsx",
      "Checked, going live",
    ]);
    expect(r.steps).toBeGreaterThan(3);
  });

  test("finish says where the change is and what to try", async () => {
    const r = await build([
      call("edit_file", { ...importReset, path: "src/styles.css", old_text: "--accent: #c4491f;", new_text: "--accent: #ff6a4d;" }),
      call("finish", { summary: "Turns the buttons tomato", spotlight: " .wave ", try: "Tap the wave button." }),
    ]);
    expect(r.outcome).toEqual({ kind: "finished", summary: "Turns the buttons tomato", spotlight: ".wave", try: "Tap the wave button" });
  });

  test("decline settles without changing anything", async () => {
    const r = await build([call("decline", { reason: "I won't build a fake bank login." }), fauxAssistantMessage([fauxText("unused")])]);
    expect(r.outcome).toEqual({ kind: "declined", reason: "I won't build a fake bank login." });
    expect(r.draft.changed()).toBe(false);
  });

  test("a draft that keeps failing the check stops after the allowed tries", async () => {
    const turns = [call("edit_file", importReset)];
    for (let i = 0; i < BUILD_FINISH_ATTEMPTS; i++) turns.push(call("finish", { summary: "Adds a reset button" }));
    const r = await build([...turns, fauxAssistantMessage([fauxText("unused")])]);
    expect(r.outcome.kind).toBe("invalid");
    expect(r.outcome.kind === "invalid" && r.outcome.problems).toEqual(['src/App.jsx imports "./Reset.jsx", but src/Reset.jsx does not exist']);
  });

  test("a bad edit and an empty finish are errors the model recovers from", async () => {
    const r = await build([
      call("edit_file", { path: "src/App.jsx", old_text: "no such text", new_text: "x" }),
      call("finish", { summary: "Nothing" }),
      call("edit_file", { path: "src/styles.css", old_text: "--accent: #c4491f;", new_text: "--accent: #ff6a4d;" }),
      call("finish", { summary: "Turns the buttons tomato" }),
    ]);
    expect(r.outcome).toEqual({ kind: "finished", summary: "Turns the buttons tomato" });
    expect(r.draft.read("src/styles.css")).toContain("--accent: #ff6a4d;");
  });

  test("a run that ends its turn without finish is a stop, not a commit", async () => {
    const r = await build([call("edit_file", importReset), fauxAssistantMessage([fauxText("All done!")])]);
    expect(r.outcome).toEqual({ kind: "stopped", reason: "done" });
  });
});
