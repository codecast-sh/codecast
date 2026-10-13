import { describe, expect, test } from "bun:test";
import { interactivePromptMessageUuid } from "./daemon.js";

// Regression coverage for poll spam: the daemon emits a synthetic AskUserQuestion
// message for a live interactive prompt from several call sites (post-inject,
// post-resume, heartbeat) that race inside checkForInteractivePrompt's capture
// delay. The old id embedded Date.now(), so each racing emit wrote a DISTINCT
// server row and the same prompt rendered 4-5x in the UI. The id is now derived
// from the prompt's content, so addMessages (which upserts by
// (conversation_id, message_uuid)) collapses identical prompts to one row.
describe("interactivePromptMessageUuid", () => {
  const sid = "1315bf1d-bf64-4ab8-8500-103bdeedcb0c";
  const prompt = {
    question: "instance type?",
    options: [
      { label: "mac2-m2pro.metal" },
      { label: "mac2-m2.metal" },
      { label: "mac2.metal (cheapest)" },
    ],
  };

  test("identical prompts produce the same id (idempotent across racing emits)", () => {
    const a = interactivePromptMessageUuid(sid, prompt);
    const b = interactivePromptMessageUuid(sid, structuredClone(prompt));
    expect(a).toBe(b);
  });

  test("id is namespaced by session and prefix", () => {
    const id = interactivePromptMessageUuid(sid, prompt);
    expect(id.startsWith(`interactive-prompt-${sid}-`)).toBe(true);
  });

  test("different question changes the id", () => {
    const other = { ...prompt, question: "region?" };
    expect(interactivePromptMessageUuid(sid, prompt)).not.toBe(
      interactivePromptMessageUuid(sid, other),
    );
  });

  test("different option set changes the id", () => {
    const other = { ...prompt, options: [...prompt.options, { label: "Other" }] };
    expect(interactivePromptMessageUuid(sid, prompt)).not.toBe(
      interactivePromptMessageUuid(sid, other),
    );
  });

  test("option descriptions are part of the identity", () => {
    const withDesc = {
      ...prompt,
      options: prompt.options.map((o, i) => (i === 0 ? { ...o, description: "fastest" } : o)),
    };
    expect(interactivePromptMessageUuid(sid, prompt)).not.toBe(
      interactivePromptMessageUuid(sid, withDesc),
    );
  });

  test("confirmation flag changes the id", () => {
    const confirm = { ...prompt, isConfirmation: true };
    expect(interactivePromptMessageUuid(sid, prompt)).not.toBe(
      interactivePromptMessageUuid(sid, confirm),
    );
  });

  test("different session changes the id", () => {
    expect(interactivePromptMessageUuid(sid, prompt)).not.toBe(
      interactivePromptMessageUuid("e5e5410e-f381-4c95-acde-2f08ddbb1b26", prompt),
    );
  });
});
