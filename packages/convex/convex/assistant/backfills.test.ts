import { describe, expect, test } from "bun:test";
import { needsHostedTitle } from "./backfills";

describe("needsHostedTitle", () => {
  const ask = "Help me write a kind note saying no to Sam's dinner on Friday";
  test("a conversation no pass titled, or titled with its own first words, needs a name", () => {
    expect(needsHostedTitle({ title: ask, first_prompt: ask })).toBe(true);
    expect(needsHostedTitle({ title: "Help me write a kind note saying no…", subtitle: "- Asked", first_prompt: ask })).toBe(true);
  });
  test("a generated or custom name stays", () => {
    expect(needsHostedTitle({ title: "Declining Sam's dinner", subtitle: "- Asked", first_prompt: ask })).toBe(false);
    expect(needsHostedTitle({ title: ask, first_prompt: ask, title_is_custom: true })).toBe(false);
  });
});
