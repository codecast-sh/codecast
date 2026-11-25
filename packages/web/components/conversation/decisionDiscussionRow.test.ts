import { describe, expect, test } from "bun:test";
import { classifyUserMessage } from "./classify";
import { formatDecisionDiscussion, parseDecisionDiscussion } from "@codecast/shared/contracts";

// ct-101382: a person's words about a decision, delivered into the session that
// presents it, quote that decision. The row must keep which decision it is, so
// the transcript can open it and answer it there, not flatten it to a blockquote.
describe("a decision quoted inside a conversation", () => {
  const content = formatDecisionDiscussion({
    decision: "sd-614",
    question: "Retire verified_pending: an agent's change is ready to ship and waiting on one decision from a person: Ship, Revise or Drop",
    from: "Ada Lovelace",
    body: "Ada Lovelace: what does Revise send back?",
  });
  const kind = classifyUserMessage({ _id: "m", role: "user", content, timestamp: 1 } as any) as Record<string, unknown>;

  test("keeps the decision it quotes, outside the markdown body, so the row can open and answer it", () => {
    const carried = Object.entries(kind)
      .filter(([k]) => k !== "body" && k !== "from" && k !== "kind")
      .some(([, v]) => JSON.stringify(v ?? null).includes("sd-614"));
    expect(carried).toBe(true);
  });

  test("strips the About header when the decision is named with spaces", () => {
    const raw = `<decision-discussion decision="sd-614" from="Ada">\nAbout Retire verified_pending ("Ship, Revise or Drop"):\n\nwhat does Revise send back?\n</decision-discussion>`;
    const parsed = parseDecisionDiscussion(raw)!;
    expect(parsed.about).toBe('About Retire verified_pending ("Ship, Revise or Drop"):');
    expect(parsed.body).toBe("what does Revise send back?");
  });
});
