import { describe, expect, test } from "bun:test";
import { quotesIn, readCallRecord } from "../callRecord";

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

  test("an answer that is not a call is null", () => {
    expect(readCallRecord("No item with that id.")).toBeNull();
    expect(readCallRecord(undefined)).toBeNull();
  });
});
