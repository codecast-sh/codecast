import { describe, expect, test } from "bun:test";
import { explainAskFailure } from "./sessionAsk";

// 281 asks failed with "retry in a moment" over two weeks, including ones no
// retry could fix (an empty credit balance); agents retried, then dumped the
// whole transcript to a file. Each failure now says whether to retry and names
// the read that works without the model.
describe("explainAskFailure", () => {
  test("a transient model failure says to retry soon", () => {
    const out = explainAskFailure("The model did not answer (the model API answered 529: Overloaded)", "jx7abcd");
    expect(out).toContain("retry in about 30 s");
    expect(out).toContain("cast read jx7abcd -n 20");
  });

  test("an empty credit balance says retrying will not help", () => {
    const out = explainAskFailure("The model did not answer (the model API answered 400: Your credit balance is too low)", "jx7abcd");
    expect(out).toContain("Retrying will not help");
    expect(out).not.toContain("retry in about");
  });

  test("the hourly cap names the fallback", () => {
    expect(explainAskFailure("You have asked a lot this hour. Try again in 12 min", "jx7abcd")).toContain("Meanwhile cast read jx7abcd -n 20");
  });

  test("access refusals say why and what to do", () => {
    expect(explainAskFailure("No session found for that id", "jx7abcd")).toContain("cast sessions jx7abcd");
    expect(explainAskFailure("You do not have access to that session", "jx7abcd")).toContain("private to its owner");
  });

  test("a CLI timeout reads as transient", () => {
    expect(explainAskFailure("Request to https://x/cli/read/ask timed out after 300000ms (backend may be overloaded)", "jx7abcd")).toContain("retry in about 30 s");
  });

  test("text a newer server already explained passes through", () => {
    const once = explainAskFailure("The model did not answer (the model call timed out)", "jx7abcd");
    expect(explainAskFailure(once, "jx7abcd")).toBe(once);
  });
});
