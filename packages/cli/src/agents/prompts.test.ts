import { describe, expect, test } from "bun:test";
import { buildImplementerPrompt } from "./prompts.js";

const plan = { short_id: "pl-7", title: "Shared log", goal: "Ship it", tasks: [] };
const task = { short_id: "ct-1", title: "Wire the log", description: "Do it." };
/** Fence tags are random per render; the rest of the prompt is what is compared. */
const unfenced = (s: string) => s.replace(/untrusted-[0-9a-f]+/g, "untrusted");

describe("buildImplementerPrompt and the plan's messaging policy", () => {
  test("a plan with no policy, or lead, gets no shared-log section", () => {
    const none = buildImplementerPrompt(plan, task);
    expect(none).not.toContain("## Shared log");
    expect(unfenced(buildImplementerPrompt({ ...plan, messaging_policy: "lead" }, task))).toBe(unfenced(none));
  });

  test("a shared-log plan tells its agent how to post to the log, with the plan id", () => {
    const prompt = buildImplementerPrompt({ ...plan, messaging_policy: "shared-log" }, task);
    expect(prompt).toContain("## Shared log");
    expect(prompt).toContain('cast plan comment pl-7 --type fact|fail|interface "<entry>"');
    expect(prompt).not.toContain("<plan_id>");
    expect(prompt.indexOf("## Shared log")).toBeLessThan(prompt.indexOf("## How to work"));
  });
});
