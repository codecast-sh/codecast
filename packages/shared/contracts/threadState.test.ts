import { describe, test, expect } from "bun:test";
import {
  threadStateResult,
  normalizeThreadState,
  threadStateHeadline,
  threadStateCardLine,
  threadStateRows,
  threadStateAskParts,
  threadStateFreshness,
  parseThreadStateStatus,
  hasThreadState,
  THREAD_STATE_MAX_CHARS,
  THREAD_STATE_AGING_MSGS,
  THREAD_STATE_STALE_MSGS,
  THREAD_STATE_STALE_MS,
} from "./threadState";

describe("normalizeThreadState", () => {
  test("trims and collapses blank-line runs", () => {
    expect(normalizeThreadState("  Status: waiting\n\n\n\nNext: ship it  ")).toBe(
      "Status: waiting\n\nNext: ship it",
    );
  });

  test("keeps single blank lines and strips trailing spaces per line", () => {
    expect(normalizeThreadState("a   \n\nb")).toBe("a\n\nb");
  });

  test("drops shared indentation but keeps nesting", () => {
    expect(normalizeThreadState("    Status: green\n      - detail\n    Next: ship")).toBe(
      "Status: green\n  - detail\nNext: ship",
    );
  });

  test("normalizes CRLF", () => {
    expect(normalizeThreadState("a\r\nb")).toBe("a\nb");
  });

  test("empty once trimmed reads as a clear", () => {
    expect(normalizeThreadState("   \n \n ")).toBe("");
  });

  test("caps overlong text with an ellipsis", () => {
    const out = normalizeThreadState("x".repeat(THREAD_STATE_MAX_CHARS + 500));
    expect(out.length).toBe(THREAD_STATE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("threadStateHeadline", () => {
  test("takes the first non-empty line", () => {
    expect(threadStateHeadline("\n\nWaiting on CI\nNext: merge")).toBe("Waiting on CI");
  });

  test("drops a leading bullet", () => {
    expect(threadStateHeadline("- Waiting on CI")).toBe("Waiting on CI");
  });

  test("drops redundant Status/Goal labels but keeps other labels", () => {
    expect(threadStateHeadline("Status: waiting on CI")).toBe("waiting on CI");
    expect(threadStateHeadline("Goal: ship the auth fix")).toBe("ship the auth fix");
    expect(threadStateHeadline("Blocked: needs a key")).toBe("Blocked: needs a key");
  });

  test("empty text yields empty headline", () => {
    expect(threadStateHeadline("   ")).toBe("");
  });
});

describe("threadStateFreshness", () => {
  const now = 1_000_000_000;

  test("a state written a few messages ago is fresh", () => {
    const r = threadStateFreshness(
      { thread_state_at: now - 60_000, thread_state_msg_count: 100 },
      104,
      now,
    );
    expect(r.freshness).toBe("fresh");
    expect(r.messagesSince).toBe(4);
    expect(r.ageMs).toBe(60_000);
  });

  test("crossing the aging threshold dims it", () => {
    const r = threadStateFreshness(
      { thread_state_at: now, thread_state_msg_count: 0 },
      THREAD_STATE_AGING_MSGS,
      now,
    );
    expect(r.freshness).toBe("aging");
  });

  test("crossing the stale message threshold marks it stale", () => {
    const r = threadStateFreshness(
      { thread_state_at: now, thread_state_msg_count: 0 },
      THREAD_STATE_STALE_MSGS,
      now,
    );
    expect(r.freshness).toBe("stale");
  });

  test("a busy agent turn does not by itself age a just-written state", () => {
    const r = threadStateFreshness(
      { thread_state_at: now - 3 * 60_000, thread_state_msg_count: 100 },
      140,
      now,
    );
    expect(r.freshness).toBe("fresh");
  });

  test("age alone can make it stale in a quiet thread", () => {
    const r = threadStateFreshness(
      { thread_state_at: now - THREAD_STATE_STALE_MS, thread_state_msg_count: 10 },
      10,
      now,
    );
    expect(r.freshness).toBe("stale");
    expect(r.messagesSince).toBe(0);
  });

  test("a missing stored count yields null rather than a false zero", () => {
    const r = threadStateFreshness({ thread_state_at: now - 1000 }, 500, now);
    expect(r.messagesSince).toBeNull();
    expect(r.freshness).toBe("fresh");
  });

  test("a shrinking message count never goes negative", () => {
    const r = threadStateFreshness(
      { thread_state_at: now, thread_state_msg_count: 100 },
      40,
      now,
    );
    expect(r.messagesSince).toBe(0);
  });
});

describe("parseThreadStateStatus", () => {
  test("maps loose spellings onto the three states", () => {
    expect(parseThreadStateStatus("working")).toBe("working");
    expect(parseThreadStateStatus("in-progress")).toBe("working");
    expect(parseThreadStateStatus("In Progress")).toBe("working");
    expect(parseThreadStateStatus("wip")).toBe("working");
    expect(parseThreadStateStatus("blocked")).toBe("blocked");
    expect(parseThreadStateStatus("needs_input")).toBe("blocked");
    expect(parseThreadStateStatus("needs input")).toBe("blocked");
    expect(parseThreadStateStatus("done")).toBe("done");
    expect(parseThreadStateStatus("Complete")).toBe("done");
  });

  test("anything unrecognized is null, never a guess", () => {
    expect(parseThreadStateStatus("")).toBeNull();
    expect(parseThreadStateStatus(null)).toBeNull();
    expect(parseThreadStateStatus(undefined)).toBeNull();
    expect(parseThreadStateStatus("urgent")).toBeNull();
  });
});

describe("threadStateCardLine", () => {
  test("takes the ask: a You: line beats the headline", () => {
    const text = "Release is waiting on a signing key\nYou: add it to the repo secrets\nNext: re-run the release";
    expect(threadStateCardLine(text)).toBe("add it to the repo secrets");
  });

  test("an older note's Blocked: line counts as the ask", () => {
    const text = "Auth fix\nBlocked: needs a prod key\nNext: deploy";
    expect(threadStateCardLine(text)).toBe("needs a prod key");
  });

  test("a Status: line never takes the slot, even ahead of a Blocked: line", () => {
    const status = "Projects as a first-class place to work\nStatus: all four done, tests green\nNext: nothing blocking";
    expect(threadStateCardLine(status)).toBe("Projects as a first-class place to work");
    const both = "Build box login needs a token\nStatus: deploys wait on CI\nBlocked: the token file is empty";
    expect(threadStateCardLine(both)).toBe("the token file is empty");
  });

  test("under a Goal: headline, the Status: line says where it stands", () => {
    expect(threadStateCardLine("Goal: ship the chart\nStatus: waiting on review")).toBe("waiting on review");
    expect(threadStateCardLine("Goal: ship the chart\nStatus: waiting on review\nBlocked: needs a key")).toBe("needs a key");
  });

  test("falls back to the headline when there is no ask", () => {
    expect(threadStateCardLine("Waiting on CI — nothing to decide yet")).toBe(
      "Waiting on CI — nothing to decide yet",
    );
  });

  test("shows an ask's words, not the command that ends it", () => {
    const text = "Build box login is waiting on a token\nYou: paste it over ssh: `ssh -t intern 'cat > ~/.token'`";
    expect(threadStateCardLine(text)).toBe("paste it over ssh");
    expect(threadStateCardLine("Head\nYou: `gh secret set KEY`")).toBe("gh secret set KEY");
    expect(threadStateCardLine("Head\nYou: run `bun test` and say if it passes")).toBe("run bun test and say if it passes");
  });

  test("a single Status: line still reads as its content", () => {
    expect(threadStateCardLine("Status: deploying pass 3")).toBe("deploying pass 3");
  });
});

describe("threadStateRows", () => {
  test("one row per line after the headline, labeled by the word before the colon", () => {
    const text = "Waiting on CI for the sync fix\nDone: fix pushed · unit tests green\n\nNext: 3 PM re-check";
    expect(threadStateRows(text)).toEqual([
      { label: "Done", text: "fix pushed · unit tests green" },
      { label: "Next", text: "3 PM re-check" },
    ]);
  });

  test("older labels and unlabeled lines keep their place", () => {
    const text = "Big migration\nStatus: half done\n- Likely cause: the index\nthe rest waits on review";
    expect(threadStateRows(text)).toEqual([
      { label: "Status", text: "half done" },
      { label: "Likely cause", text: "the index" },
      { label: null, text: "the rest waits on review" },
    ]);
  });

  test("a sentence with a colon is not a label", () => {
    expect(threadStateRows("Head\nRun this when CI is green: deploy.sh")).toEqual([
      { label: null, text: "Run this when CI is green: deploy.sh" },
    ]);
  });

  test("a headline alone has no rows", () => {
    expect(threadStateRows("Shipped: all four fixes verified")).toEqual([]);
  });

  test("a station's json report is left out, the result keeps it", () => {
    const text = 'Reproduced the miss on the base\n```json\n{"reproduced": true}\n```\nNext: hand to implement';
    expect(threadStateRows(text)).toEqual([{ label: "Next", text: "hand to implement" }]);
    expect(threadStateResult(text)).toBe('{"reproduced": true}');
  });

  test("a report the display cap cut mid-block is left out too", () => {
    expect(threadStateRows('Proven\nNote: see below\n```json\n{"outcome": "red", "evidence": "lo…')).toEqual([
      { label: "Note", text: "see below" },
    ]);
  });
});

describe("threadStateAskParts", () => {
  test("splits off a command that ends the ask, and only one that ends it", () => {
    expect(threadStateAskParts("paste it: `ssh box 'x'`")).toEqual({ prose: "paste it", command: "ssh box 'x'" });
    expect(threadStateAskParts("run `bun test` first")).toEqual({ prose: "run `bun test` first", command: null });
    expect(threadStateAskParts("approve the gate")).toEqual({ prose: "approve the gate", command: null });
  });
});

describe("hasThreadState", () => {
  test("blank or absent text is no state", () => {
    expect(hasThreadState(null)).toBe(false);
    expect(hasThreadState({})).toBe(false);
    expect(hasThreadState({ thread_state: "   " })).toBe(false);
    expect(hasThreadState({ thread_state: "up" })).toBe(true);
  });
});

describe("threadStateResult", () => {
  const long = "x".repeat(1500);
  test("keeps the fenced json block whole, past the display cap", () => {
    const text = `Proven.\n\n\`\`\`json\n{ "outcome": "red", "evidence": "${long}" }\n\`\`\`\n`;
    expect(JSON.parse(threadStateResult(text)!)).toEqual({ outcome: "red", evidence: long });
  });

  test("takes the last block, and none when there is none or it does not parse", () => {
    expect(threadStateResult('```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```')).toBe('{"a":2}');
    expect(threadStateResult("Working on it.")).toBeNull();
    expect(threadStateResult('```json\n{ "a": \n```')).toBeNull();
  });

  test("a block no fence closes runs to the end of the text, as in markdown (ct-59565)", () => {
    // A station's report pinned from a heredoc that ends on the json's closing brace, past the display cap.
    const report = { outcome: "open", evidence: long, residue: 4 };
    const text = `Kept open: both findings are real.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n`;
    expect(JSON.parse(threadStateResult(text)!)).toEqual(report);
    // Prose after an unclosed block leaves nothing that parses; an earlier closed block still stands.
    expect(threadStateResult('```json\n{"a":1}\nthen more words')).toBeNull();
    expect(threadStateResult('```json\n{"a":1}\n```\nthen\n```json\n{"a":')).toBe('{"a":1}');
  });

  test("a block whose strings hold fences, closed on the json's last line, is read whole (ct-59945)", () => {
    const report = JSON.stringify({ outcome: "proposed", proposal_md: "## Fix\n\n```ts\nconst a = 1;\n```\n" }, null, 1);
    expect(JSON.parse(threadStateResult(`Proposed.\n\n\`\`\`json\n${report}\`\`\``)!)).toMatchObject({ outcome: "proposed" });
  });
});
