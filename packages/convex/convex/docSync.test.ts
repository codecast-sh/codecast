import { describe, expect, test } from "bun:test";
import { isRacyEmptyOverwrite, toMarkdown } from "./docSync";

// Regression for the two doc-content wipes: opening a content-bearing doc in
// the web editor before its markdown prop loaded either (a) seeded an empty v1
// snapshot (June 2026 incident), or (b) on a CLI-edited doc, had
// ExternalEditSync setContent("") replace the whole doc at version > 1 (July
// 2026 incident, wiped s97a49h5). submitSnapshot then overwrote doc.content
// with "". The guard must reject both shapes and nothing else.
describe("isRacyEmptyOverwrite", () => {
  test("JUNE BUG: v1 empty seed over a doc that still has content is rejected", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "",
        existingContent: "# Union Outreach\n\nlots of real content here",
        cliEditedAt: null,
      }),
    ).toBe(true);
  });

  test("JULY BUG: v>1 empty overwrite of a CLI-edited doc is rejected", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 4,
        derivedMarkdown: "",
        existingContent: "# Cold email throughput\n\n5kB of real analysis",
        cliEditedAt: 1784105015602,
      }),
    ).toBe(true);
  });

  test("a real v1 seed (markdown present) is allowed through", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "# Architecture Summary\n\nbody",
        existingContent: "# Architecture Summary\n\nbody",
        cliEditedAt: null,
      }),
    ).toBe(false);
  });

  test("a normal edit of a CLI-edited doc (markdown present) is allowed through", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 7,
        derivedMarkdown: "# Doc\n\nedited in the browser",
        existingContent: "# Doc\n\nolder text",
        cliEditedAt: 1784105015602,
      }),
    ).toBe(false);
  });

  test("a brand-new empty doc (no existing content) is allowed through", () => {
    for (const existingContent of ["", undefined, null] as const) {
      expect(
        isRacyEmptyOverwrite({ version: 1, derivedMarkdown: "", existingContent, cliEditedAt: null }),
      ).toBe(false);
      expect(
        isRacyEmptyOverwrite({
          version: 3,
          derivedMarkdown: "",
          existingContent,
          cliEditedAt: 1784105015602,
        }),
      ).toBe(false);
    }
  });

  test("a genuine full clear of a web-only doc (version > 1, no CLI stamp) is allowed through", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 2,
        derivedMarkdown: "",
        existingContent: "old content",
        cliEditedAt: null,
      }),
    ).toBe(false);
    expect(
      isRacyEmptyOverwrite({
        version: 137,
        derivedMarkdown: "",
        existingContent: "old content",
        cliEditedAt: undefined,
      }),
    ).toBe(false);
  });

  test("whitespace is treated as empty on both sides", () => {
    // whitespace-only existing content is not worth protecting
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "",
        existingContent: "   \n  ",
        cliEditedAt: null,
      }),
    ).toBe(false);
    // whitespace-only derived markdown still counts as an empty overwrite
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "  \n ",
        existingContent: "real content",
        cliEditedAt: null,
      }),
    ).toBe(true);
    expect(
      isRacyEmptyOverwrite({
        version: 5,
        derivedMarkdown: "  \n ",
        existingContent: "real content",
        cliEditedAt: 1784105015602,
      }),
    ).toBe(true);
  });
});

// The markdown mirror (doc.content) is derived from the collab snapshot by
// toMarkdown. Every editor atom that stands in for authored text must write
// back the exact markdown it came from — entityId nodes used to fall through
// to "" (a ct-/pl- id vanished from doc.content on the first web edit), and
// mentions serialized as bare `@label`, dropping the object id.
describe("toMarkdown entity round-trip", () => {
  const para = (...content: any[]) => ({
    type: "doc",
    content: [{ type: "paragraph", content }],
  });
  const text = (t: string) => ({ type: "text", text: t });

  test("entityId atoms write their short id back", () => {
    const doc = para(text("fix filed under "), {
      type: "entityId",
      attrs: { shortId: "ct-4102" },
    });
    expect(toMarkdown(doc).trim()).toBe("fix filed under ct-4102");
  });

  test("entityRef link form writes [label](href), bare href when label is the href", () => {
    const labeled = para({
      type: "entityRef",
      attrs: {
        form: "link",
        label: "session",
        href: "https://codecast.sh/conversation/jx7c6zk",
        refId: null,
      },
    });
    expect(toMarkdown(labeled).trim()).toBe(
      "[session](https://codecast.sh/conversation/jx7c6zk)",
    );
    const bare = para({
      type: "entityRef",
      attrs: {
        form: "link",
        label: "https://codecast.sh/tasks/ct-1",
        href: "https://codecast.sh/tasks/ct-1",
        refId: null,
      },
    });
    expect(toMarkdown(bare).trim()).toBe("https://codecast.sh/tasks/ct-1");
  });

  test("entityRef mention form writes @[label id]", () => {
    const doc = para({
      type: "entityRef",
      attrs: { form: "mention", label: "Fix the auth race", refId: "ct-4102", href: null },
    });
    expect(toMarkdown(doc).trim()).toBe("@[Fix the auth race ct-4102]");
  });

  test("object mentions keep their id; person mentions stay @Name", () => {
    const session = para({
      type: "mention",
      attrs: { type: "session", id: "jd7abc", shortId: "jx7c6zk", label: "Call brief bug fix" },
    });
    expect(toMarkdown(session).trim()).toBe("@[Call brief bug fix jx7c6zk]");

    const docMention = para({
      type: "mention",
      attrs: { type: "doc", id: "jd7abcdefabcdefabcdefabcdefabcde", label: "Approvals Board" },
    });
    expect(toMarkdown(docMention).trim()).toBe(
      "@[Approvals Board doc:jd7abcdefabcdefabcdefabcdefabcde]",
    );

    const person = para({
      type: "mention",
      attrs: { type: "person", id: "user123", label: "Samvit" },
    });
    expect(toMarkdown(person).trim()).toBe("@Samvit");
  });
});

// A date pill (dateMention node) writes back `@[<label> date:<iso>]` — the
// shared mention vocabulary read mode and EntityRefExtension both parse. It
// used to fall through to "" and vanish from doc.content on every web edit.
describe("toMarkdown date mentions", () => {
  test("dateMention serializes label + iso", () => {
    expect(
      toMarkdown({
        type: "dateMention",
        attrs: { type: "date", id: "2026-08-24", label: "Today", dateValue: "2026-08-24" },
      }),
    ).toBe("@[Today date:2026-08-24]");
  });

  test("label falls back to the iso date when absent", () => {
    expect(
      toMarkdown({ type: "dateMention", attrs: { type: "date", id: "2026-08-24" } }),
    ).toBe("@[2026-08-24 date:2026-08-24]");
  });

  test("a date pill inside a paragraph keeps its surrounding text", () => {
    const md = toMarkdown({
      type: "paragraph",
      content: [
        { type: "text", text: "Ship by " },
        { type: "dateMention", attrs: { type: "date", id: "2026-09-01", label: "Sep 1, 2026", dateValue: "2026-09-01" } },
        { type: "text", text: " at the latest." },
      ],
    });
    expect(md).toBe("Ship by @[Sep 1, 2026 date:2026-09-01] at the latest.\n\n");
  });
});
