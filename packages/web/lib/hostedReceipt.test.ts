import { describe, expect, it } from "bun:test";
import { createdRefs, hostedReceipt } from "./hostedReceipt";

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
    expect(r).toEqual({ summary: "Read 3 unread emails from the past week · Drafted a reply to Dana Ruiz", counted: "2 steps", created: [], steps: 2 });
  });

  it("names the first steps of a busy segment and counts the rest", () => {
    const calls = ["web_search", "fetch_page", "fetch_page", "create_task", "remember"].map((name, i) => ({ id: `c${i}`, name, input: "{}" }));
    expect(hostedReceipt(calls, resultFor)).toEqual({ summary: "Searched the web · Read a web page · 3 more steps", counted: "5 steps", created: [], steps: 5 });
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
    expect(hostedReceipt(calls, resultFor).summary).toBe("Didn't update a note (you said no) · Sending an email to Dana");
    expect(hostedReceipt(calls, resultFor, { asking: true }).summary).toBe("Didn't update a note (you said no) · Waiting for your go-ahead to send an email to Dana");
  });

  it("a to-do the turn added is named by its id, for the receipt's live pill", () => {
    const calls = [{ id: "a", name: "create_task", input: { title: "Call the dentist" } }, { id: "b", name: "list_tasks" }];
    const results: Record<string, any> = { a: { content: '{"id":"ct-57070"}' }, b: { content: '[{"id":"ct-1"}]' } };
    expect(createdRefs(calls, (c) => results[c.id!])).toEqual(["ct-57070"]);
  });

  it("a note the turn wrote or rewrote is named as a doc reference; reading one is not", () => {
    const id = "k57abcdefghijkmnpqrstvwxyz234567";
    const calls = [{ id: "w", name: "write_doc", input: { title: "Packing list" } }, { id: "r", name: "replace_doc" }, { id: "x", name: "read_doc" }];
    const results: Record<string, any> = { w: { content: `Created doc ${id}.` }, r: { content: `Rewrote doc ${id}.` }, x: { content: `Doc ${id}: Packing list` } };
    expect(createdRefs(calls, (c) => results[c.id!])).toEqual([`doc:${id}`]);
  });
});

describe("one step that made one thing", () => {
  it("counts its steps, and the line's words drop the quoted name the link carries", async () => {
    const { wordsBeforeName } = await import("../components/conversation/HostedMadeLine");
    const call = { id: "c1", name: "schedule_routine", input: { title: "Morning stretch" } };
    const receipt = hostedReceipt([call], () => ({ content: "Scheduled tr-12", is_error: false }));
    expect(receipt.steps).toBe(1);
    expect(receipt.created).toEqual(["tr-12"]);
    expect(wordsBeforeName(receipt.summary)).toBe("Set up the routine");
    expect(wordsBeforeName('Added a to-do: "Renew passport"')).toBe("Added a to-do:");
    expect(wordsBeforeName("Checked your to-dos")).toBeNull();
  });
});
