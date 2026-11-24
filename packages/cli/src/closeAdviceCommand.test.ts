import { describe, expect, test } from "bun:test";
import { formatCloseAdvice } from "./closeAdviceCommand.js";
import { COMMAND_GROUPS } from "./commandGroups.js";

describe("cast advise-close", () => {
  test("is a hidden, lazily loaded command named for the gesture it advises on", async () => {
    const group = COMMAND_GROUPS.find((g) => g.token === "advise-close");
    expect(group?.hidden).toBe(true);
    expect(COMMAND_GROUPS.some((g) => g.token === "advise")).toBe(false);
    expect(typeof (await group!.load!())).toBe("function");
  });

  test("says the feature is off in the server's shared words", () => {
    const message = "Close advice is not enabled for this team. A team admin can turn it on under Settings → Team.";
    expect(formatCloseAdvice({ short_id: "jx7abc", off: "team", message })).toBe(`jx7abc: ${message}`);
  });

  test("names the inbox's Close, since the CLI has none, with the verdict's reason and what decided it", () => {
    expect(formatCloseAdvice({ short_id: "jx7abc", advice: { verdict: "close", reason: "hides it, back when it's done or needs you", decided_by: "facts" } }))
      .toBe("jx7abc  close — Close it from the inbox: hides it, back when it's done or needs you (verified facts)");
    expect(formatCloseAdvice({ short_id: "jx7abc", advice: { verdict: "close", reason: "Shipped the login fix.", decided_by: "model" } }))
      .toBe("jx7abc  close — Close it from the inbox; Shipped the login fix (model)");
    expect(formatCloseAdvice({ short_id: "jx7abc", advice: { verdict: "close", reason: "Shipped the login fix", decided_by: "settle" } }))
      .toBe("jx7abc  close — Close it from the inbox; Shipped the login fix (settle classifier)");
    expect(formatCloseAdvice({ short_id: "jx7abc", advice: { verdict: "needs_input", reason: "approve or decline the merge", decided_by: "pin" } }))
      .toBe("jx7abc  needs you — approve or decline the merge (its pinned status)");
    expect(formatCloseAdvice({ short_id: "jx7abc", advice: { verdict: "needs_input", reason: "Choose between the two schemas", decided_by: "model" } }))
      .toBe("jx7abc  needs you — Choose between the two schemas (model)");
  });

  test("a decider a newer server names prints as sent", () => {
    expect(formatCloseAdvice({ short_id: "jx7abc", advice: { verdict: "close", reason: "Shipped it", decided_by: "rules" as any } }))
      .toBe("jx7abc  close — Close it from the inbox; Shipped it (rules)");
  });

  test("a failed model call prints its error", () => {
    expect(formatCloseAdvice({ short_id: "jx7abc", error: "the model call timed out" })).toBe("No advice for jx7abc: the model call timed out.");
  });
});
