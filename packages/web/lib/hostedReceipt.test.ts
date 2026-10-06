import { describe, expect, it } from "bun:test";
import { hostedReceipt } from "./hostedReceipt";

const results: Record<string, { content: string; is_error?: boolean }> = {
  a: { content: JSON.stringify({ results: [1, 2, 3] }) },
  declined: { content: JSON.stringify([{ type: "text", text: "The person declined replace_doc. It did not run." }]), is_error: true },
};
/** Every call has come back fine unless `results` says otherwise; `open`
 *  has no result yet. */
const resultFor = (call: { id?: string }) => (call.id === "open" ? undefined : (call.id && results[call.id]) || { content: "ok" });

describe("a hosted conversation's receipt", () => {
  it("says each step in plain words, reading the stored JSON", () => {
    const r = hostedReceipt([
      { id: "a", name: "search_mail", input: '{"query":"is:unread newer_than:7d"}' },
      { id: "b", name: "draft_reply", input: '{"to":"Dana Ruiz <dana@x.org>"}' },
    ], resultFor);
    expect(r).toEqual({ summary: "Read 3 unread emails from the past week · Drafted a reply to Dana Ruiz", counted: "2 steps" });
  });

  it("names the first steps of a busy segment and counts the rest", () => {
    const calls = ["web_search", "fetch_page", "fetch_page", "create_task", "remember"].map((name, i) => ({ id: `c${i}`, name, input: "{}" }));
    expect(hostedReceipt(calls, resultFor)).toEqual({ summary: "Searched the web · Read a web page · 3 more steps", counted: "5 steps" });
  });

  it("never folds away a single step, and never says a tool's name", () => {
    const calls = ["list_events", "frobnicate", "recall"].map((name) => ({ name, input: "{}" }));
    expect(hostedReceipt(calls, resultFor).summary).toBe("Checked your calendar · Did a step · Remembered what you told me");
  });

  it("never says a declined or unfinished step happened", () => {
    const calls = [
      { id: "declined", name: "replace_doc", input: "{}" },
      { id: "open", name: "send_email", input: '{"to":"dana@x.org"}' },
    ];
    expect(hostedReceipt(calls, resultFor).summary).toBe("Didn't update a note (you said no) · Waiting to send an email to Dana");
  });
});
