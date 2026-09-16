import { describe, expect, test } from "bun:test";
import { decisionQueueItems, needsDocumentPage, optionPageSlugs } from "../decisionQueue";

// The transcript card (the-line.md L10) carries the kind, the form, the
// category and the option extras (body, cost, risk, evidence, page) so it
// renders the right controls or links to the document page.
const row = (id: string, extra: Record<string, any> = {}) => ({
  _id: id, short_id: `sd-${id}`, conversation_id: `c-${id}`, session_id: "s", question: id,
  options: [{ label: "A", page_slug: "page-a", cost: "2 days", risk: "low" }, { label: "B", body_md: "**B**", evidence: [{ label: "bench", url: "https://x" }] }],
  blocking: true, status: "pending" as const, created_at: 1, ...extra,
});

describe("decisionQueueItems carries the document fields", () => {
  test("kind, form, category, short id, doc id and the full options ride the item", () => {
    const form = { fields: [{ key: "n", label: "How many", type: "number" as const }] };
    const [item] = decisionQueueItems({ a: row("a", { kind: "form", form, category: "review", doc_id: "doc1" }) } as any, {});
    expect(item.kind).toBe("form");
    expect(item.form).toEqual(form);
    expect(item.category).toBe("review");
    expect(item.shortId).toBe("sd-a");
    expect(item.docId).toBe("doc1");
    expect(item.options[0].page_slug).toBe("page-a");
    expect(item.options[0].cost).toBe("2 days");
    expect(item.options[1].body_md).toBe("**B**");
    expect(item.options[1].evidence?.[0].url).toBe("https://x");
  });
  test("a plain row leaves the kind undefined (single) and carries no page", () => {
    const [item] = decisionQueueItems({ a: row("a", { options: [{ label: "A" }] }) } as any, {});
    expect(item.kind).toBeUndefined();
    expect(optionPageSlugs(item.options)).toEqual([]);
  });
});

describe("needsDocumentPage", () => {
  test("a doc body, an option page, or a kind beyond single links to the page", () => {
    expect(needsDocumentPage({ options: [{ label: "A" }] })).toBe(false);
    expect(needsDocumentPage({ options: [{ label: "A" }], kind: "single" })).toBe(false);
    expect(needsDocumentPage({ options: [{ label: "A" }], docId: "d" })).toBe(true);
    expect(needsDocumentPage({ options: [{ label: "A", page_slug: "p" }] })).toBe(true);
    expect(needsDocumentPage({ options: [{ label: "A" }], kind: "multi" })).toBe(true);
  });
  test("optionPageSlugs keeps option order and drops options without a page", () => {
    expect(optionPageSlugs([{ label: "A" }, { label: "B", page_slug: "b" }, { label: "C", page_slug: "c" }])).toEqual(["b", "c"]);
  });
});
