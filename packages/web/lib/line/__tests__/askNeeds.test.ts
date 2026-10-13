import { describe, expect, test } from "bun:test";
import { needCount, needForRef, needGroups } from "../lineNeeds";
import { askNeeds, dueWords, type AskSignal } from "../askNeeds";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
// Union's escalations of 2026-10-13, as the line's feed carries them: the head of the detail, the day the server read.
const detail = (act: string, about: string, reason: string) => [
  "1 escalation and difficulty notes under this fingerprint in the last 7 days.",
  `Ask: ${act}, for the problem "${about}".`,
  "This one: a escalation from broker woken by `proactive`, 2026-10-13T06:02:50.392Z.",
  "",
  "The agent's reason (data, its own words):",
  "```",
  reason,
].join("\n");
const sig = (id: string, over: Partial<AskSignal>): AskSignal => ({
  _id: id, short_id: id, source: "union.escalation", subject: "proactive", title: "Brokers keep asking a person", created_at: day("2026-10-13") + 6 * 3_600_000, ...over,
});
const fifth = sig("sg-3067", {
  detail_md: detail("Deliver", "approved counterparty pitches unsendable from contact run", "FIFTH escalation. A client has been waiting 19 days…"),
  evidence_url: "https://admin.unionmatching.com/worker/task/057a5439", task_id: "t58847", project_id: "pBroker", ask_due: day("2026-10-15"),
});
const stathis = sig("sg-3066", {
  detail_md: detail("Call", "call cards expire undialed, email ceiling reached", "Stathis Ventouris (Managing Director, Core Capital Partners SA) answered once"),
  evidence_url: "https://admin.unionmatching.com/worker/task/6b870afe", task_id: "t58847",
});
const late = sig("sg-2739", {
  detail_md: detail("Call", "no phone on file and email pitch unanswered", "Jennah Ward has three term sheets; we promised her an update by today (Oct 12)."),
  evidence_url: "https://admin.unionmatching.com/worker/task/aa", ask_due: day("2026-10-12"),
});

describe("what agents asked a person to do by a date (askNeeds)", () => {
  const refOf = (id: string) => (id === "t58847" ? "ct-58847" : null);
  const needs = askNeeds([fifth, stathis, late], refOf);

  test("an ask with a date is a counted need, wherever its finding was filed", () => {
    expect(needs.map((n) => n.ref).sort()).toEqual(["sg-2739", "sg-3067"]);
    const n = needForRef(needs, "sg-3067")!;
    expect(n.kind).toBe("ask");
    expect(n.title).toBe("Deliver: Approved counterparty pitches unsendable from contact run");
    expect(n.person).toMatchObject({ act: "Deliver", due: day("2026-10-15"), url: fifth.evidence_url, filed: { id: "t58847", ref: "ct-58847" } });
    // Not the problem it was filed to: its band and status never take it.
    expect(n.caseId).toBeNull();
    expect(needCount(needs)).toBe(2);
  });
  test("an ask without a date stays on its finder's page", () => {
    expect(needForRef(needs, "sg-3066")).toBeNull();
  });
  test("Done takes it off; a newer escalation of the same task replaces the older", () => {
    expect(askNeeds([{ ...fifth, ask_done: { at: 1 } }], refOf)).toHaveLength(0);
    const again = { ...fifth, _id: "sg-3100", short_id: "sg-3100", created_at: fifth.created_at + 1000, ask_due: day("2026-10-16") };
    expect(askNeeds([fifth, again], refOf).map((n) => n.ref)).toEqual(["sg-3100"]);
  });
  test("the group comes second, soonest due first", () => {
    const g = needGroups(needs).find((x) => x.key === "ask")!;
    expect(g.label).toBe("Due from you");
    expect(g.needs.map((n) => n.ref)).toEqual(["sg-2739", "sg-3067"]);
  });
});

describe("dueWords", () => {
  const now = day("2026-10-13") + 15 * 3_600_000;
  test("against today", () => {
    expect(dueWords(day("2026-10-15"), now)).toEqual({ short: "Due Thu, Oct 15", when: "Thu, Oct 15", late: false });
    expect(dueWords(day("2026-10-13"), now)).toMatchObject({ short: "Due today", late: false });
    expect(dueWords(day("2026-10-14"), now)).toMatchObject({ short: "Due tomorrow" });
    expect(dueWords(day("2026-10-12"), now)).toEqual({ short: "1 day late", when: "Mon, Oct 12, 1 day late", late: true });
  });
});
