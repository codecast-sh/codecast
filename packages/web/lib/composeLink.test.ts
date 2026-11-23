import { describe, expect, test } from "bun:test";
import { parseComposeLink, draftForTask, resolveLinkProject, stripComposeLink } from "./composeLink";
import { PREFILL_MAX_LENGTH } from "./composerPrefill";

const parse = (qs: string) => parseComposeLink(new URLSearchParams(qs));

describe("parseComposeLink", () => {
  test("no compose and no task is no link", () => {
    expect(parse("")).toBeNull();
    expect(parse("s=abc&agent=codex&project=/x")).toBeNull();
    expect(parse("task=not-a-task")).toBeNull();
  });

  test("the draft arrives as written, decoded once", () => {
    expect(parse("compose=About%20in-22%20Infrastructure%3A%20")).toEqual({ draft: "About in-22 Infrastructure: " });
    expect(parse("compose=")).toEqual({ draft: "" });
  });

  test("markup stays plain text", () => {
    const html = `<img src=x onerror=alert(1)><script>x()</script>[a](javascript:alert(1))`;
    expect(parse(`compose=${encodeURIComponent(html)}`)?.draft).toBe(html);
  });

  test("the draft is capped at PREFILL_MAX_LENGTH", () => {
    const link = parse(`compose=${"a".repeat(PREFILL_MAX_LENGTH * 5)}`);
    expect(link?.draft.length).toBe(PREFILL_MAX_LENGTH);
  });

  test("control characters go, newlines and tabs stay, CRLF becomes LF", () => {
    expect(parse(`compose=${encodeURIComponent("a\u0000b\u001b[31mc\r\nd\te\u007f")}`)?.draft).toBe("ab[31mc\nd\te");
  });

  test("characters that draw nothing go; emoji joiners stay; line separators become newlines", () => {
    const hidden = "Summarize README" + "\u{E0049}\u{E0067}\u{E006E}" + "‮evil‬" + "a​b﻿⁦c⁩";
    expect(parse(`compose=${encodeURIComponent(hidden)}`)?.draft).toBe("Summarize READMEevilabc");
    expect(parse(`compose=${encodeURIComponent("👩‍💻 x y")}`)?.draft).toBe("👩‍💻 x\ny");
  });

  test("hidden selector runs and fillers go; one selector and ZWNJ stay", () => {
    const smuggled = "Fix it \u{1F642}" + "\uFE01\uFE02\uFE03".repeat(50) + "\u{E0100}\u{E01EF}" + "\u3164\u115F\u034F\u2800";
    expect(parse(`compose=${encodeURIComponent(smuggled)}`)?.draft).toBe("Fix it \u{1F642}\uFE01");
    expect(parse(`compose=${encodeURIComponent("\u2764\uFE0F \u0645\u06CC\u200C\u062E\u0648\u0627\u0645")}`)?.draft)
      .toBe("\u2764\uFE0F \u0645\u06CC\u200C\u062E\u0648\u0627\u0645");
  });

  test("joiners and selectors anywhere but right after a drawn character go", () => {
    expect(parse(`compose=${encodeURIComponent("a" + "\u200C\u200D".repeat(16) + "b")}`)?.draft).toBe("a\u200Cb");
    expect(parse(`compose=${encodeURIComponent("\u{1F600}" + "\u200D\uFE0F".repeat(8) + "c")}`)?.draft).toBe("\u{1F600}\u200Dc");
    expect(parse(`compose=${encodeURIComponent("\u200Dx \u200C\uFE0Fy")}`)?.draft).toBe("x y");
    const real = "\u{1F469}\u200D\u{1F4BB} \u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F \u2764\uFE0F \u0645\u06CC\u200C\u062E";
    expect(parse(`compose=${encodeURIComponent(real)}`)?.draft).toBe(real);
  });

  test("runs of blank lines fold to one, so nothing sits below the box's edge", () => {
    expect(parse(`compose=${encodeURIComponent("Fix the typo" + "\n".repeat(40) + "HIDDEN")}`)?.draft).toBe("Fix the typo\n\nHIDDEN");
    expect(parse(`compose=${encodeURIComponent("a\n \n\t\n \nb\n\nc")}`)?.draft).toBe("a\n\nb\n\nc");
    for (const filler of ["\u200D", "\uFE0F", "\u00A0", "\u3000", "\u200B"]) {
      expect(parse(`compose=${encodeURIComponent("hi" + `\n${filler}`.repeat(300) + "\nsecret")}`)?.draft).toBe("hi\n\nsecret");
    }
  });

  test("C1 controls go too, and a cut never leaves half an emoji", () => {
    expect(parse(`compose=${encodeURIComponent("a\u0085b\u009bc")}`)?.draft).toBe("abc");
    const draft = parse(`compose=${encodeURIComponent("A".repeat(PREFILL_MAX_LENGTH - 1) + "\u{1F600}")}`)!.draft;
    expect(draft).toBe("A".repeat(PREFILL_MAX_LENGTH - 1));
  });

  test("a repeated parameter takes its first value", () => {
    expect(parse("compose=first&compose=second&task=ct-1&task=ct-2&agent=codex&agent=claude")).toEqual({
      draft: "first",
      task: "ct-1",
      agent: "codex",
    });
  });

  test("a task alone is a link; a task id is matched strictly and lowercased", () => {
    expect(parse("task=CT-99abc")).toEqual({ draft: "", task: "ct-99abc" });
    for (const bad of ["ct-", "ct-1/../2", "pl-12", "ct-1%20x", `ct-${"a".repeat(40)}`, "ct-1;drop"]) {
      expect(parse(`compose=x&task=${bad}`)).toEqual({ draft: "x" });
    }
  });

  test("agents are the registry's, in either spelling; anything else is dropped", () => {
    expect(parse("compose=x&agent=claude")?.agent).toBe("claude_code");
    expect(parse("compose=x&agent=claude_code")?.agent).toBe("claude_code");
    expect(parse("compose=x&agent=Codex")?.agent).toBe("codex");
    expect(parse("compose=x&agent=codecast")?.agent).toBe("codecast");
    for (const bad of ["cowork", "gpt", "", "claude;rm", "__proto__"]) {
      expect(parse(`compose=x&agent=${bad}`)?.agent).toBeUndefined();
    }
  });

  test("a project is kept as text for later resolution, capped and single-line", () => {
    expect(parse("compose=x&project=%2FUsers%2Fme%2Fcode%2Fapp")?.project).toBe("/Users/me/code/app");
    expect(parse(`compose=x&project=${encodeURIComponent(" a\nb ")}`)?.project).toBe("a b");
    expect(parse(`compose=x&project=${"p".repeat(5000)}`)?.project?.length).toBe(512);
    expect(parse("compose=x&project=")?.project).toBeUndefined();
  });
});

describe("draftForTask", () => {
  test("a task-only link reads like the task list's start", () => {
    expect(draftForTask("", "ct-7")).toBe("Let's do this task ct-7 ");
    expect(draftForTask("   ", "ct-7")).toBe("Let's do this task ct-7 ");
  });
  test("a draft naming the task is left exactly as written", () => {
    expect(draftForTask("Continue ct-7: ", "ct-7")).toBe("Continue ct-7: ");
    expect(draftForTask("continue CT-7", "ct-7")).toBe("continue CT-7");
  });
  test("a draft that does not name the task gets its id", () => {
    expect(draftForTask("Pick this up ", "ct-7")).toBe("Pick this up ct-7 ");
    expect(draftForTask("re ct-993591 too", "ct-99359")).toBe("re ct-993591 too ct-99359 ");
    expect(draftForTask("see xct-7", "ct-7")).toBe("see xct-7 ct-7 ");
  });
  test("the id fits inside the cap, at the end", () => {
    const out = draftForTask("a".repeat(PREFILL_MAX_LENGTH), "ct-123456");
    expect(out.length).toBe(PREFILL_MAX_LENGTH);
    expect(out.endsWith(" ct-123456 ")).toBe(true);
  });
});

describe("resolveLinkProject", () => {
  const known = {
    paths: ["/Users/me/code/app", "/Users/me/src/"],
    byName: (n: string) => (n === "app" ? "/Users/me/code/app" : undefined),
  };
  test("a known folder, or one inside it, resolves", () => {
    expect(resolveLinkProject("/Users/me/code/app", known)).toBe("/Users/me/code/app");
    expect(resolveLinkProject("/Users/me/code/app/", known)).toBe("/Users/me/code/app");
    expect(resolveLinkProject("/Users/me/src/other", known)).toBe("/Users/me/src/other");
  });
  test("a bare name resolves by folder name", () => {
    expect(resolveLinkProject("app", known)).toBe("/Users/me/code/app");
  });
  test("anything else falls back to the composer's own default", () => {
    expect(resolveLinkProject(undefined, known)).toBeUndefined();
    expect(resolveLinkProject("/Users/me/code/application", known)).toBeUndefined();
    expect(resolveLinkProject("/Users/me/code/app/../../../etc", known)).toBeUndefined();
    expect(resolveLinkProject("/etc", known)).toBeUndefined();
    expect(resolveLinkProject("nope", known)).toBeUndefined();
    expect(resolveLinkProject("~/code/app", known)).toBeUndefined();
    expect(resolveLinkProject("/", { paths: ["/"], byName: () => undefined })).toBeUndefined();
  });
});

describe("stripComposeLink", () => {
  test("takes out only the link's parameters", () => {
    expect(stripComposeLink("/inbox", "?compose=x&task=ct-1&agent=codex&project=a&s=abc")).toBe("/inbox?s=abc");
    expect(stripComposeLink("/inbox", "?compose=x&compose=y")).toBe("/inbox");
  });
});
