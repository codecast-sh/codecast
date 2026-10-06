import { describe, expect, test } from "bun:test";
import { endsWithQuestion, hasCanvas, hasLocalHtmlPath, hasPublishedPage, hasTextChart, momentForMessage, pickFeatureMoment } from "./featureMoments";

describe("hasTextChart", () => {
  test("a bar chart drawn in block glyphs", () => {
    expect(hasTextChart("Latency:\n```\nredis  ████████ 34ms\nmemory ████ 18ms\nnone   ██████████████ 92ms\n```")).toBe(true);
  });
  test("a box-drawn table", () => {
    expect(hasTextChart("```\n┌──────┬─────┐\n│ a    │ b   │\n└──────┴─────┘\n```")).toBe(true);
  });
  test("ordinary code is not a chart", () => {
    expect(hasTextChart("```ts\nconst a = 1;\nconst b = 2;\n```")).toBe(false);
  });
  test("one separator line is not a chart", () => {
    expect(hasTextChart("```\n──────────\nok\n```")).toBe(false);
  });
  test("glyphs outside a code block do not count", () => {
    expect(hasTextChart("████\n████\n████")).toBe(false);
  });
  test("a cast-canvas block is already a visual", () => {
    expect(hasTextChart("```cast-canvas\n█\n█\n█\n```")).toBe(false);
  });
});

describe("hasLocalHtmlPath", () => {
  test.each([
    "Report written to /tmp/report.html",
    "Open file:///Users/me/out/index.html",
    "See `./dist/index.html`",
    "Saved at ~/Desktop/chart.html.",
  ])("%s", (text) => expect(hasLocalHtmlPath(text)).toBe(true));

  test.each([
    "Live at https://codecast.sh/a/report.html",
    "Edited components/Report.tsx",
    "The page renders fine.",
  ])("not: %s", (text) => expect(hasLocalHtmlPath(text)).toBe(false));
});

describe("endsWithQuestion", () => {
  test("a closing question", () => expect(endsWithQuestion("Done with the API.\n\nShould I also migrate the old rows?")).toBe(true));
  test("a question in bold", () => expect(endsWithQuestion("**Which option do you want?**")).toBe(true));
  test("a question followed by a statement", () => expect(endsWithQuestion("Want me to proceed?\n\nI'll wait.")).toBe(false));
  test("a question mark inside closing code is ignored", () => expect(endsWithQuestion("Done.\n```\nif (a?) b\n```")).toBe(false));
});

describe("momentForMessage", () => {
  test("a closing question on a waiting session asks for Decision queue", () => {
    expect(momentForMessage("Redis or memory?", { isLast: true, needsInput: true })?.slug).toBe("decide");
  });
  test("the same question while the agent is still working is no moment", () => {
    expect(momentForMessage("Redis or memory?", { isLast: true, needsInput: false })).toBeNull();
  });
  test("an older question is no moment", () => {
    expect(momentForMessage("Redis or memory?", { isLast: false, needsInput: true })).toBeNull();
  });
});

describe("pickFeatureMoment", () => {
  const msgs = [
    { id: "a", text: "Chart:\n```\n███\n██\n█\n```" },
    { id: "b", text: "Wrote /tmp/out.html" },
    { id: "c", text: "All done." },
  ];
  test("the newest message with a feature still on offer", () => {
    expect(pickFeatureMoment(msgs, { needsInput: false }, () => true)?.id).toBe("b");
  });
  test("skips features no longer on offer", () => {
    expect(pickFeatureMoment(msgs, { needsInput: false }, (s) => s !== "publish")?.id).toBe("a");
  });
  test("nothing on offer, no moment", () => {
    expect(pickFeatureMoment(msgs, { needsInput: false }, () => false)).toBeNull();
  });
});

describe("output that shows a feature", () => {
  test("a canvas block", () => expect(hasCanvas("Here:\n```cast-canvas\n<div></div>\n```")).toBe(true));
  test("a published page on its own line", () => expect(hasPublishedPage("Done.\n\nhttps://codecast.sh/a/weekly-errors\n")).toBe(true));
  test("a captioned published page", () => expect(hasPublishedPage("[Error trends](https://codecast.sh/a/weekly-errors)")).toBe(true));
  test("a page mentioned mid-sentence still counts only on its own line", () => expect(hasPublishedPage("see https://example.com/a/x")).toBe(false));
  test("a working-around moment outranks a shown one in the same message", () => {
    expect(momentForMessage("Wrote /tmp/r.html\n```cast-canvas\n<p/>\n```", { isLast: false, needsInput: false })).toMatchObject({ slug: "publish", kind: "missing" });
  });
  test("a canvas alone is a shown moment", () => {
    expect(momentForMessage("```cast-canvas\n<p/>\n```", { isLast: false, needsInput: false })).toMatchObject({ slug: "visual", kind: "shown" });
  });
});
