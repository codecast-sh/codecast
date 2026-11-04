import { describe, expect, test } from "bun:test";
import { typedMenuReply, typedPollAnswer } from "./typedPollAnswer";

// The /model menu as the daemon scraped it (Claude Code, 2026-09-27). Its
// highlight opens on the current model (row 2), not on row 1.
const modelMenu = {
  options: ["Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5", "Haiku 4.5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7"].map(label => ({ label })),
};
const answer = (prompt: Parameters<typeof typedPollAnswer>[0], text: string) => {
  const out = typedPollAnswer(prompt, text);
  return out ? JSON.parse(out) : null;
};

describe("typedPollAnswer", () => {
  test("a typed 1 picks row 1 of /model, not the first label containing a 1", () => {
    // Regression: "1" matched "Fable 5.1" and was sent as Down,Down,Enter, which
    // from the /model highlight on row 2 landed on Sonnet 5.
    expect(answer(modelMenu, "1")).toEqual({ __cc_poll: true, keys: ["1"], display: "Default (recommended)" });
    expect(answer(modelMenu, " 9 ")).toEqual({ __cc_poll: true, keys: ["9"], display: "Opus 4.7" });
  });

  test("a choice is a number key, never counted arrows", () => {
    expect(answer(modelMenu, "sonnet 5")).toEqual({ __cc_poll: true, keys: ["4"], display: "Sonnet 5" });
  });

  test("an exact label beats a label that merely contains the text", () => {
    expect(answer(modelMenu, "Fable 5")?.display).toBe("Fable 5");
    expect(answer(modelMenu, "Opus 5")?.display).toBe("Opus 5");
  });

  test("text that names no option stays a plain message", () => {
    expect(answer(modelMenu, "12")).toBeNull();
    expect(answer(modelMenu, "what does effort mean here?")).toBeNull();
  });

  test("confirmations map to Enter and Escape", () => {
    const confirm = { options: [{ label: "Continue" }, { label: "Cancel" }], isConfirmation: true };
    expect(answer(confirm, "yes")?.keys).toEqual(["Enter"]);
    expect(answer(confirm, "1")?.keys).toEqual(["Enter"]);
    expect(answer(confirm, "esc")?.keys).toEqual(["Escape"]);
    expect(answer(confirm, "maybe later")).toBeNull();
  });

  test("a word inside a label names nothing; the label's opening words do", () => {
    const menu = { options: ["Keep going", "Wait here, then continue later"].map(label => ({ label })) };
    expect(answer(menu, "continue")).toBeNull();
    expect(answer(menu, "wait here")?.display).toBe("Wait here, then continue later");
    expect(answer(modelMenu, "sonnet")?.display).toBe("Sonnet 5");
  });

  test("a limit dialog is never answered by text (2026-10-04: continue armed a day-long wait)", () => {
    const limit = { options: ["Stop and wait for limit to reset", "Wait here, then continue automatically at Oct 5 at 3pm", "Switch to usage credits"].map(label => ({ label })) };
    expect(answer(limit, "continue")).toBeNull();
    expect(answer(limit, "2")).toBeNull();
  });
});

describe("typedMenuReply", () => {
  const question = { options: ["Cap at 2 full suites", "Only the slow-test tier", "Both: cap 2 + slow tier", "Type something.", "Chat about this"].map(label => ({ label })) };
  const reply = (prompt: Parameters<typeof typedMenuReply>[0], text: string) => {
    const out = typedMenuReply(prompt, text);
    return out ? JSON.parse(out) : null;
  };

  test("text that names no option answers the agent's question as free text", () => {
    expect(reply(question, "Sorry typo I meant do all your suggestions")).toEqual({ __cc_poll: true, text: "Sorry typo I meant do all your suggestions" });
    expect(reply(question, "Only the slow-test tier")).toMatchObject({ keys: ["2"] });
  });

  test("the terminal's own dialogs are never answered by text", () => {
    const interstitial = { options: [{ label: "Switch to Opus 4.8" }, { label: "Stay on Fable 5.1" }] };
    expect(reply(interstitial, "please continue")).toBeNull();
    expect(reply({ ...question, isConfirmation: true }, "please continue")).toBeNull();
    expect(reply({ ...question, unnumbered: true }, "please continue")).toBeNull();
  });
});
