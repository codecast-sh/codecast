// Approval rules over the package's own tool scopes: what an allow or refuse
// rule decides, how outside content narrows them, and what the card shows.
import { describe, expect, test } from "bun:test";
import { allowScopeIn, approvalContext, withRules, type AllowScopes, type RuleView } from "./rules";
import { MAIL_SCOPES } from "./mail";
import { CALENDAR_SCOPES } from "./calendar";
import { WEB_SCOPES } from "./web";

const SCOPES: AllowScopes = { ...MAIL_SCOPES, ...CALENDAR_SCOPES, ...WEB_SCOPES };

const verdict = (rules: RuleView[], readOutside = false) => {
  const gate = withRules(() => "ask", rules, SCOPES, () => readOutside);
  return async (name: string, input: Record<string, unknown>, risk: "read" | "write" = "write") => {
    const decided = await gate({ id: "c", name, input, risk });
    return typeof decided === "string" ? decided : decided.verdict;
  };
};

describe("withRules", () => {
  test("an allow or refuse rule decides only a write the gate would ask about", async () => {
    const call = verdict([
      { tool: "send_mail", decision: "allow", match: "dana@example.com" },
      { tool: "archive", decision: "refuse" },
      { tool: "label", decision: "allow" },
      { tool: "create_event", decision: "allow", match: "dana@example.com" },
      { tool: "update_event", decision: "allow", match: "no one" },
      { tool: "fetch_page", decision: "allow" },
      { tool: "unknown_tool", decision: "allow" },
    ]);
    expect(await call("send_mail", { to: ["Dana <Dana@Example.com>"] })).toBe("allow");
    expect(await call("send_mail", { to: ["dana@example.com"], cc: ["lee@example.com"] })).toBe("ask");
    expect(await call("send_mail", { to: ['"<dana@example.com>" <eve@evil.example>'] })).toBe("ask");
    expect(await call("archive", { thread_ids: ["t"] })).toBe("refuse");
    expect(await call("label", { thread_ids: ["t"] })).toBe("allow");
    expect(await call("create_event", { attendees: ["dana@example.com"] })).toBe("allow");
    expect(await call("create_event", { attendees: ["dana@example.com"], notify: true })).toBe("ask");
    expect(await call("update_event", { event_id: "e" })).toBe("allow");
    expect(await call("update_event", { event_id: "e", remove_attendees: ["x@example.com"] })).toBe("ask");
    expect(await call("fetch_page", { url: "https://example.com" })).toBe("ask");
    expect(await call("unknown_tool", {})).toBe("ask");
    expect(await call("label", {}, "read")).toBe("ask");
  });

  test("with outside content in view, only rules that reach no one apply", async () => {
    const call = verdict([
      { tool: "send_mail", decision: "allow", match: "dana@example.com" },
      { tool: "create_event", decision: "allow", match: "no one" },
      { tool: "archive", decision: "allow" },
    ], true);
    expect(await call("send_mail", { to: ["dana@example.com"] })).toBe("ask");
    expect(await call("create_event", { title: "Focus" })).toBe("allow");
    expect(await call("archive", { thread_ids: ["t"] })).toBe("allow");
  });

  test("a scope names exactly the people a call reaches", () => {
    expect(allowScopeIn(SCOPES, { name: "send_mail", input: { to: ['"Lee, Q" <Lee@Example.com>', "dana@example.com"], cc: ["DANA@example.com"] } })).toMatchObject({
      kind: "match",
      match: "dana@example.com, lee@example.com",
    });
    expect(allowScopeIn(SCOPES, { name: "toString", input: {} }).kind).toBe("never");
  });
});

describe("approvalContext", () => {
  test("shows every field literally, long text whole", () => {
    const md = approvalContext({ to: ["a@x.com", "b@x.com"], subject: "Hi *there*", location: "`Room` 4", body: "One\nTwo ``` fence", notify: false });
    expect(md).toContain("**To:** `a@x.com, b@x.com`");
    expect(md).toContain("**Subject:** `Hi *there*`");
    expect(md).toContain("**Location:** `` `Room` 4 ``");
    expect(md).toContain("**Notify:** No");
    expect(md).toContain("````text\nOne\nTwo ``` fence\n````");
  });
});
