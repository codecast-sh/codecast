import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import kitJs from "../kit/decision-kit.js" with { type: "text" };
import { DECISION_KIT_GUIDE, DECISION_KIT_LINE, inlineDecisionKit, previewDecisionPage, usesDecisionKit } from "./decisionKit.js";
import { buildPublishPayload } from "./publish.js";

const page = (head: string) => `<!doctype html><html><head><title>T</title>${head}</head><body><main><h1>T</h1></main></body></html>`;

describe("the decision kit line", () => {
  test("the line in a page's head becomes the kit, inline, once", () => {
    const out = inlineDecisionKit(page(DECISION_KIT_LINE + "\n" + DECISION_KIT_LINE));
    expect(out).not.toContain("cast:decision-kit");
    expect(out.match(/<style data-decision-kit>/g)).toHaveLength(1);
    expect(out.match(/<script data-decision-kit>/g)).toHaveLength(1);
    expect(out).toContain("dk-thread");
    expect(out).toContain("window.__decisionKit");
  });

  test("attribute order and quoting do not matter", () => {
    expect(usesDecisionKit(`<link href='cast:decision-kit' rel="stylesheet" />`)).toBe(true);
    expect(usesDecisionKit(`<link rel="stylesheet" href="style.css">`)).toBe(false);
  });

  test("a page that does not ask for the kit is left as it is", () => {
    const plain = page(`<link rel="stylesheet" href="style.css">`);
    expect(inlineDecisionKit(plain)).toBe(plain);
  });

  test("the kit's script cannot close the tag that carries it", () => {
    const script = inlineDecisionKit(page(DECISION_KIT_LINE)).split("<script data-decision-kit>")[1].split("</script>")[0];
    expect(script).toContain("decisionKit");
    expect(script.trim().endsWith("})();")).toBe(true);
  });

  test("the preview is the page as served: the kit and the colour tokens", () => {
    const out = previewDecisionPage(page(DECISION_KIT_LINE));
    expect(out).toContain('id="cc-page-theme"');
    expect(out).toContain("<style data-decision-kit>");
  });

  test("publishing a page inlines its kit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-kit-"));
    try {
      const file = path.join(dir, "page.html");
      fs.writeFileSync(file, page(DECISION_KIT_LINE));
      const payload = buildPublishPayload(file);
      expect(payload.content).toContain("<style data-decision-kit>");
      expect(payload.content).not.toContain("cast:decision-kit");
      expect(payload.title).toBe("T");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the guide names the line a page needs", () => {
    expect(DECISION_KIT_GUIDE).toContain(DECISION_KIT_LINE);
  });
});

// The kit's script runs in a page; its diff reading is plain functions, run here against a window that holds nothing.
function loadKit(): any {
  const win: any = {};
  const doc = { readyState: "complete", querySelectorAll: () => [], querySelector: () => null };
  new Function("window", "document", kitJs)(win, doc);
  return win.decisionKit;
}

describe("the kit reads a diff", () => {
  const kit = loadKit();
  const DIFF = [
    "diff --git a/prompts/note.md b/prompts/note.md",
    "index 1111111..2222222 100644",
    "--- a/prompts/note.md",
    "+++ b/prompts/note.md",
    "@@ -3,4 +3,4 @@ Message:",
    " Keep it short.",
    "--- an old rule that starts with dashes",
    "+Lead with what the contact can act on.",
    " Include the link.",
    " Sign off.",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const a = 1;",
    "+export const b = 2;",
    "",
  ].join("\n");

  test("files, counts and rows, with a removed line that looks like a header", () => {
    const files = kit.parseUnified(DIFF);
    expect(files.map((f: any) => [f.name, f.added, f.removed])).toEqual([["prompts/note.md", 1, 1], ["src/new.ts", 2, 0]]);
    expect(files[0].hunks[0].context).toBe("Message:");
    expect(files[0].hunks[0].rows.map((r: any) => r.t).join("")).toBe(" -+  ");
    expect(files[0].hunks[0].rows[1].s).toBe("-- an old rule that starts with dashes");
  });

  test("a trimmed hunk ends at the next file's header, so a new file reads whole", () => {
    const trimmed = [
      "diff --git a/src/slots.ts b/src/slots.ts",
      "--- a/src/slots.ts",
      "+++ b/src/slots.ts",
      "@@ -60,20 +60,30 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "diff --git a/src/offers.ts b/src/offers.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/offers.ts",
      "@@ -0,0 +1,76 @@",
      "+export const one = 1;",
      "+export const two = 2;",
      "@@ -90,2 +100,2 @@ later",
      "-x",
      "+y",
    ].join("\n");
    const files = kit.parseUnified(trimmed);
    expect(files.map((f: any) => [f.name, f.added, f.removed, f.hunks.length])).toEqual([["src/slots.ts", 1, 1, 1], ["src/offers.ts", 3, 1, 2]]);
    expect(files[0].hunks[0].rows.map((r: any) => r.s)).toEqual(["const a = 1;", "const b = 2;", "const b = 3;"]);
    expect(files[1].hunks[1].context).toBe("later");
  });

  test("a sentence's changed words are found, and stray shared words do not split a change", () => {
    const a = "A prompt, warm note is what turns a dial nobody answered into a live conversation.";
    const b = "It is worth sending only for what it gives the contact, not the news that we called.";
    const whole = kit.segments(kit.wordDiff(a, b));
    const same = whole.filter((s: any) => s.eq != null).reduce((n: number, s: any) => n + s.eq.length, 0);
    expect(same / a.length).toBeLessThan(0.3);

    const small = kit.segments(kit.wordDiff("Doors open at six tonight.", "Doors open at seven tonight."));
    expect(small).toEqual([{ eq: "Doors open at " }, { del: "six", ins: "seven" }, { eq: " tonight." }]);
  });
});
