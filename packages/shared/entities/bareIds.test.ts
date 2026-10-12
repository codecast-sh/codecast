import { describe, expect, test } from "bun:test";
import { BARE_ID_AFTER, BARE_ID_BEFORE, BARE_ID_SOURCE, bareEntityIdRegex, entityRoute, entityTypeFromId } from "./index";

// A scanner that embeds the id branch in its own alternation (the phone's
// markdown tokenizer) must bound it the way the shared scanner does, or a
// hyphenated word like "5-in-1" reads as "5-" and initiative in-1.
const embedded = () => new RegExp(`(\`[^\`]+\`)|${BARE_ID_BEFORE}(${BARE_ID_SOURCE})${BARE_ID_AFTER}`, "gi");

const ids = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[2] ?? m[0]).filter(Boolean);

describe("bare ids in prose", () => {
  test("a hyphenated word is prose on both scanners", () => {
    for (const text of ["a 5-in-1 dock", "the 2-in-1 laptop", "an in-app purchase", "x-ct-12-y"]) {
      expect(ids(bareEntityIdRegex(), text)).toEqual([]);
      expect(ids(embedded(), text)).toEqual([]);
    }
  });

  test("a real id still reads as one", () => {
    expect(ids(embedded(), "see ct-12 and in-7, then pl-3.")).toEqual(["ct-12", "in-7", "pl-3"]);
    expect(ids(bareEntityIdRegex(), "(tr-42)")).toEqual(["tr-42"]);
  });

  test("a role and a project read as ids, and open their sheet on the Org screen", () => {
    expect(ids(bareEntityIdRegex(), "ask or-3 about pj-mf3k2a under in-2")).toEqual(["or-3", "pj-mf3k2a", "in-2"]);
    expect(entityTypeFromId("or-3")).toBe("role");
    expect(entityTypeFromId("pj-mf3k2a")).toBe("project");
    for (const id of ["or-3", "pj-mf3k2a", "in-2"]) expect(entityRoute(entityTypeFromId(id)!, id)).toBe(`/org/${id}`);
  });

  test("a word that starts like a role or a goal stays prose", () => {
    for (const text of ["do it now or-else", "an in-app flow", "or-ange is not a role", "the or-12b draft"]) {
      expect(ids(bareEntityIdRegex(), text)).toEqual([]);
      expect(ids(embedded(), text)).toEqual([]);
    }
  });
});

