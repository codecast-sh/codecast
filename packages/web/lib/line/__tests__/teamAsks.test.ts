import { describe, expect, test } from "bun:test";
import { askCauses, dueWords, teamAsks, type AskSignal } from "../teamAsks";

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
  evidence_url: "https://admin.unionmatching.com/worker/task/057a5439", task_id: "t58847", ask_due: day("2026-10-15"),
});
const undated = sig("sg-3066", {
  detail_md: detail("Call", "call cards expire undialed, email ceiling reached", "Stathis Ventouris answered once"),
  evidence_url: "https://admin.unionmatching.com/worker/task/6b870afe",
});
const past = sig("sg-2739", {
  detail_md: detail("Call", "no phone on file and email pitch unanswered", "Jennah Ward has three term sheets; we promised her an update by today (Oct 12)."),
  evidence_url: "https://admin.unionmatching.com/worker/task/aa", ask_due: day("2026-10-12"),
});

describe("what a product's agents asked its team to do by a date (teamAsks)", () => {
  test("a dated ask is listed, soonest due first, opening its task in the product; an undated one is not", () => {
    const asks = teamAsks([fifth, undated, past]);
    expect(asks.map((a) => a.signal._id)).toEqual(["sg-2739", "sg-3067"]);
    expect(asks[1]).toMatchObject({ title: "Deliver: Approved counterparty pitches unsendable from contact run", due: day("2026-10-15"), url: fifth.evidence_url });
  });
  test("a newer escalation of the same task replaces the older; a retired one is gone", () => {
    const again = { ...fifth, _id: "sg-3100", created_at: fifth.created_at + 1000, ask_due: day("2026-10-16") };
    expect(teamAsks([fifth, again]).map((a) => a.signal._id)).toEqual(["sg-3100"]);
    expect(teamAsks([{ ...fifth, retired: { at: 1 } }])).toHaveLength(0);
  });
});

describe("dueWords", () => {
  const now = day("2026-10-13") + 15 * 3_600_000;
  test("against today, and never late: whether it was done is the product's to say", () => {
    expect(dueWords(day("2026-10-15"), now)).toEqual({ short: "Due Thu, Oct 15", past: false });
    expect(dueWords(day("2026-10-13"), now)).toEqual({ short: "Due today", past: false });
    expect(dueWords(day("2026-10-14"), now)).toEqual({ short: "Due tomorrow", past: false });
    expect(dueWords(day("2026-10-12"), now)).toEqual({ short: "Was due Mon, Oct 12", past: true });
  });
});

describe("askCauses", () => {
  // The Escalation finder's asks of 2026-10-13: nine ask a person to reach someone with no phone and unanswered email.
  const abouts: Array<[string, string]> = [
    ["Call", "no phone on file and email pitch unanswered"], ["Fix the record", "email ceiling and no phone on file"],
    ["Deliver", "promised outreach target has no contact channel on file"], ["Deliver", "promised counterparty outreach cannot be sent from contact run"],
    ["Fix the record", "email unanswered, no phone on file"], ["Deliver", "approved counterparty pitches unsendable from contact run"],
    ["Deliver", "promised partner approach, no channel on file for target"], ["Deliver", "legal entity and regulatory facts not in agent context"],
    ["Fix the record", "no phone on file, email unanswered, live opt-in waiting"], ["Fix the record", "email ceiling reached and no phone on file"],
    ["Fix the record", "no phone and email unanswered on live match"], ["Fix the record", "no phone and email unanswered on consent pitch"],
    ["Call", "decision-check card expired undialed twice"], ["Fix the record", "no reply by email and no phone on file"],
    ["Fix the record", "no phone and email unanswered after two touches"], ["Deliver", "human contact on WhatsApp not delivered; callback card misdirected to voice dial"],
  ];
  const asks = teamAsks(abouts.map(([act, about], i) => sig(`sg-${i}`, { detail_md: detail(act, about, "Someone Named waits."), evidence_url: `https://u/worker/task/${i}`, ask_due: day("2026-10-12") + i * 86_400_000 })));
  const causes = askCauses(asks);
  test("the same cause about different contacts is one group, soonest first; unrelated asks stay alone", () => {
    const phone = causes.find((c) => c.asks.length === 9)!;
    expect(phone.about).toBe("No phone on file and email pitch unanswered");
    expect(phone.asks.every((a) => /phone/i.test(a.title))).toBe(true);
    expect(causes.find((c) => c.asks.some((a) => /legal entity/i.test(a.title)))!.asks.length).toBe(1);
    expect(causes.find((c) => c.asks.some((a) => /WhatsApp/i.test(a.title)))!.asks.length).toBe(1);
    expect(causes.reduce((n, c) => n + c.asks.length, 0)).toBe(asks.length);
    expect(causes[0]).toBe(phone);
  });
  test("a group never chains: every two asks in it read alike", () => {
    const channel = causes.find((c) => c.asks.some((a) => /no contact channel/i.test(a.title)))!;
    expect(channel.asks.map((a) => a.title).some((t) => /cannot be sent/i.test(t))).toBe(false);
  });
});
