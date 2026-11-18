// What the trigger form sends (ct-95585 review): a new trigger states every
// run field; an edit sends only what the person changed, so a schedule-only
// save never restates an agent the form cannot show (grok shown as claude).
import { expect, test } from "bun:test";
import { runValuesOf, triggerFormFields } from "./triggerFormFields";

const grok = { prompt: "Sweep", title: "Daily sweep", mode: "apply", agent_type: "grok", project_path: "/repo" };

test("an edit that touches nothing in the run fields sends none of them", () => {
  const init = runValuesOf(grok);
  expect(init.agent).toBe("claude");
  expect(triggerFormFields(init, { ...init }, { isEdit: true, hosted: false })).toEqual({});
  expect(triggerFormFields(runValuesOf({ prompt: "Sweep" }), runValuesOf({ prompt: "Sweep" }), { isEdit: true, hosted: false })).toEqual({});
});

test("an edit sends exactly the fields the person changed", () => {
  const init = runValuesOf(grok);
  expect(triggerFormFields(init, { ...init, title: "Weekly sweep " }, { isEdit: true, hosted: false })).toEqual({ title: "Weekly sweep" });
  expect(triggerFormFields(init, { ...init, agent: "codex", project: " " }, { isEdit: true, hosted: false })).toEqual({ agent_type: "codex", project_path: "" });
  expect(triggerFormFields(init, { ...init, prompt: "Sweep twice", mode: "propose" }, { isEdit: true, hosted: true })).toEqual({ prompt: "Sweep twice", mode: "propose" });
});

test("a new trigger states every run field", () => {
  const now = { prompt: " Check CI ", title: "", mode: "apply" as const, agent: "codex" as const, project: "" };
  expect(triggerFormFields(runValuesOf(undefined), now, { isEdit: false, hosted: false })).toEqual({ prompt: "Check CI", title: undefined, mode: "apply", agent_type: "codex", project_path: undefined });
  expect(triggerFormFields(runValuesOf(undefined), now, { isEdit: false, hosted: true })).toMatchObject({ prompt: "Check CI", agent_type: "codecast" });
});
