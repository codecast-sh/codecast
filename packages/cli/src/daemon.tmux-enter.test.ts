import { describe, expect, test } from "bun:test";
import { tmuxPromptStillHasInput } from "./daemon.js";

describe("tmuxPromptStillHasInput", () => {
  test("detects unsent input still sitting at the prompt", () => {
    const pane = `
* Crunched for 14m 27s

❯ is the debug loading buffer bar supposed to work still or no?
▋
`;
    expect(
      tmuxPromptStillHasInput(pane, "is the debug loading buffer bar supposed to")
    ).toBe(true);
  });

  test("does not match when the prompt is empty", () => {
    const pane = `
  user: is the debug loading buffer bar supposed to work still or no?
  assistant: ...
❯
`;
    expect(
      tmuxPromptStillHasInput(pane, "is the debug loading buffer bar supposed to")
    ).toBe(false);
  });

  test("matches wrapped prompt input", () => {
    const pane = `
❯ is the debug loading buffer bar supposed
  to work still or no?
▋
`;
    expect(
      tmuxPromptStillHasInput(pane, "is the debug loading buffer bar supposed to work still")
    ).toBe(true);
  });
});
