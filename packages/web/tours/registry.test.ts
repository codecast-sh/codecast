// The registry (tours/registry.ts): ids unique, every tour in a listed area,
// copy short and plain, selectors well formed, the inbox tour is the one
// modal tour, and nothing a step says is a short id or a capacity word.
// Run: bun test tours/registry.test.ts
import { describe, expect, test } from "bun:test";
import { TOURS, tourById } from "./registry";
import { TOUR_AREAS } from "./types";

const AREAS = new Set(TOUR_AREAS.map((a) => a.area));
const BANNED = /\b(hands?|cap|ledger|breach|strain|span of control|model:)\b|\b(op|ct|pl|tr|or)-\d+\b|\bjx7[a-z0-9]{4}\b/i;

describe("the tours registry", () => {
  test("ids are unique and every tour sits in a listed area", () => {
    const ids = TOURS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOURS) expect(AREAS.has(t.area)).toBe(true);
    expect(tourById("org-page")?.title).toBe("The org page");
    expect(tourById("nope")).toBeUndefined();
  });

  test("every tour teaches one line; every spotlight tour has steps", () => {
    for (const t of TOURS) {
      expect(t.teaches.length).toBeGreaterThan(20);
      expect(t.teaches.length).toBeLessThanOrEqual(120);
      expect(t.teaches.endsWith(".")).toBe(true);
      if (t.kind === "modal") expect(t.steps.length).toBe(0);
      else expect(t.steps.length).toBeGreaterThanOrEqual(3);
    }
    expect(TOURS.filter((t) => t.kind === "modal").map((t) => t.id)).toEqual(["inbox"]);
  });

  test("a step is a short title and one to three plain sentences", () => {
    for (const t of TOURS) {
      const ids = t.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of t.steps) {
        expect(s.title.split(/\s+/).length, `${t.id}/${s.id} title`).toBeLessThanOrEqual(4);
        const sentences = (s.body.match(/[.!?](\s|$)/g) ?? []).length;
        expect(sentences, `${t.id}/${s.id}: ${s.body}`).toBeGreaterThanOrEqual(1);
        expect(sentences, `${t.id}/${s.id}: ${s.body}`).toBeLessThanOrEqual(3);
        expect(s.body.length, `${t.id}/${s.id} length`).toBeLessThanOrEqual(170);
        expect(BANNED.test(`${s.title} ${s.body}`), `${t.id}/${s.id}: ${s.body}`).toBe(false);
        if (s.target) for (const part of s.target.split(",")) expect(part.trim()).toMatch(/^[\[\].#a-zA-Z0-9=":_ >\-]+$/);
        if (s.action) expect(s.action.label.length).toBeLessThanOrEqual(24);
      }
    }
  });

  test("the org tours teach the product as it works today", () => {
    const org = TOURS.filter((t) => t.area === "org").map((t) => t.id);
    expect(org).toEqual(["org-page", "org-role", "org-health", "org-hire", "org-proposal"]);
    const text = TOURS.filter((t) => t.area === "org").flatMap((t) => t.steps.map((s) => `${s.title} ${s.body}`)).join(" ");
    for (const must of ["Chief of Staff", "accept", "skip", "Needs you", "Reports to", "gallery", "Pause"]) expect(text).toContain(must);
  });

  test("a route says where a tour runs", () => {
    expect(tourById("org-page")!.route!.match("/org")).toBe(true);
    expect(tourById("org-page")!.route!.match("/org/or-1")).toBe(false);
    expect(tourById("org-role")!.route!.match("/org/or-1")).toBe(true);
    expect(tourById("org-role")!.route!.match("/org")).toBe(false);
    expect(tourById("session")!.route!.match("/conversation/abc")).toBe(true);
    expect(tourById("session")!.route!.match("/tasks")).toBe(false);
    expect(tourById("inbox")!.route!.match("/")).toBe(true);
  });
});
