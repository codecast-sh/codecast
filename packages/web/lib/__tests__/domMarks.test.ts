import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { clearMarks, markMatches, markMatchesInHtml } from "../domMarks";

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  for (const k of ["window", "document", "NodeFilter", "Node"]) { saved[k] = g[k]; g[k] = (dom.window as any)[k]; }
});
afterAll(() => { for (const k of Object.keys(saved)) g[k] = saved[k]; });

describe("markMatches", () => {
  test("wraps every hit across text nodes, case-insensitively, keeping the original casing", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Facebook ads. <b>facebook</b> again</p>";
    const marks = markMatches(root, ["facebook"], { className: "hit", attrs: { "data-x": "1" } });
    expect(marks.map((m) => m.textContent)).toEqual(["Facebook", "facebook"]);
    expect(root.querySelectorAll("mark.hit[data-x]").length).toBe(2);
    expect(root.textContent).toBe("Facebook ads. facebook again");
  });
  test("several needles mark in document order; a longer needle wins a shared start", () => {
    const root = document.createElement("div");
    root.innerHTML = "ab abc";
    const marks = markMatches(root, ["ab", "abc"], { className: "hit" });
    expect(marks.map((m) => m.textContent)).toEqual(["ab", "abc"]);
  });
  test("a second pass does not nest marks; clearMarks restores whole text nodes", () => {
    const root = document.createElement("div");
    root.innerHTML = "one two one";
    markMatches(root, ["one"], { className: "hit" });
    markMatches(root, ["one"], { className: "hit" });
    expect(root.querySelectorAll("mark").length).toBe(2);
    clearMarks(root, "hit");
    expect(root.querySelectorAll("mark").length).toBe(0);
    expect(root.childNodes.length).toBe(1);
  });
});

describe("markMatchesInHtml", () => {
  test("marks inside syntax spans and returns the input untouched when nothing hits", () => {
    const html = '<span class="token keyword">const</span> facebook = 1;';
    const out = markMatchesInHtml(html, ["facebook"], { className: "search-hit" });
    expect(out).toBe('<span class="token keyword">const</span> <mark class="search-hit">facebook</mark> = 1;');
    expect(markMatchesInHtml(html, ["zzz"], { className: "search-hit" })).toBe(html);
  });
});
