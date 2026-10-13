import { describe, expect, test } from "bun:test";
import { callExcerpt, callHead, citedTimes, quotesIn, readCallRecord } from "../callRecord";

// The shape Union's history.item answers for a call, with made-up people.
const READ = `Read as email, call, chat message or activity 11112222-aaaa-4bbb-8ccc-333344445555: the id you passed was a shortened one.

## Call Outbound — 2026-10-09 14:02 (2 min, connected, status ended)

Summary:
## Names
- Union — the caller's organisation.
- Dana Reyes — CEO, Acme; the contact.
- Sam — Union colleague; the caller on this call.

## Full Account
- Dana said she would read the email first.

Transcript (3 lines, [mm:ss] from call start):
[00:00 USER] Hello.
[00:03 AGENT] This is Sam with Union, calling about the three names Mary sent.
[00:18 USER] Not really looked at it yet. I will read the email and get back to her.`;

describe("a call read through the app's history reader", () => {
  test("head, who was on it, the summary, and each transcript line by speaker", () => {
    const c = readCallRecord(READ)!;
    expect(c.head).toBe("Call Outbound — 2026-10-09 14:02 (2 min, connected, status ended)");
    expect(c.contact).toBe("Dana Reyes");
    expect(c.caller).toBe("Sam");
    expect(c.summary?.startsWith("## Names")).toBe(true);
    expect(c.summary).not.toContain("Transcript");
    expect(c.lines.map((l) => [l.at, l.who])).toEqual([["00:00", "contact"], ["00:03", "caller"], ["00:18", "contact"]]);
  });

  test("the lines a finding quotes are marked", () => {
    const quotes = quotesIn("Transcript: Dana said 'Not really looked at it yet. I will read the email' and hung up.");
    expect(quotes).toEqual(["Not really looked at it yet. I will read the email"]);
    const c = readCallRecord(READ, quotes)!;
    expect(c.lines.filter((l) => l.marked).map((l) => l.at)).toEqual(["00:18"]);
  });

  test("the reader's JSON answer is read by its text", () => {
    expect(readCallRecord(JSON.stringify({ text: READ }))?.contact).toBe("Dana Reyes");
  });

  test("its head names the people, the day and the length", () => {
    expect(callHead(readCallRecord(READ)!)).toEqual({ who: "Sam called Dana Reyes", when: "Oct 9, 14:02", length: "2 min" });
    expect(callHead({ head: null, contact: null, caller: null })).toEqual({ who: "Call", when: null, length: null });
  });

  test("an answer that is not a call is null", () => {
    expect(readCallRecord("No item with that id.")).toBeNull();
    expect(readCallRecord(undefined)).toBeNull();
  });

  // ct-57567: the Names list mentions "the caller" inside another person's line, and the call itself names no caller.
  const RILEY = `## Call Outbound — 2026-10-06 16:59 (17 min, connected, status completed)

Summary:
## Names
- Caio Senatore — the contact; IT Director at Mouts IT.
- Riley — Union colleague who spoke with Caio earlier (the caller says May 18) and sent him leads.
- Union — the caller's firm.
- San Francisco — where the caller is based.

Transcript (6 lines, [mm:ss] from call start):
[00:00 AGENT] hey there
[00:57 AGENT] i know that you spoke with riley
[10:40 USER] that's aligned with me
[10:47 AGENT] it's an interesting commission
[10:53 AGENT] so i'll send a confirmation email confirming that we're proposing 10 of the first year billing value
[11:07 USER] yeah i heard it
[14:45 USER] thanks man`;

  test("a mention of the caller inside another person's line does not name the caller", () => {
    const c = readCallRecord(RILEY)!;
    expect(c.contact).toBe("Caio Senatore");
    expect(c.caller).toBeNull();
    expect(callHead(c).who).toBe("Call with Caio Senatore");
  });

  test("the call times a finding cites mark the line said then", () => {
    const finding = 'Samvit promised "a confirmation email" [10:52]. Caio: "yeah" [10:52–11:07].';
    expect(citedTimes(finding)).toEqual(["10:52", "10:52"]);
    const c = readCallRecord(RILEY, [], citedTimes(finding))!;
    expect(c.lines.filter((l) => l.marked).map((l) => l.at)).toEqual(["10:53"]);
  });

  test("the call opens on the cited lines and a few either side", () => {
    const marked = (at: number[]) => Array.from({ length: 20 }, (_, i) => ({ marked: at.includes(i) }));
    expect(callExcerpt(marked([]))).toEqual([]);
    expect(callExcerpt(marked([10]))).toEqual([{ from: 7, to: 13 }]);
    expect(callExcerpt(marked([1, 5]))).toEqual([{ from: 0, to: 8 }]);
    expect(callExcerpt(marked([2, 15]))).toEqual([{ from: 0, to: 5 }, { from: 12, to: 18 }]);
  });
});
