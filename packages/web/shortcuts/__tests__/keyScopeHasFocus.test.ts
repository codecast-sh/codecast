import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
const { keyScopeHasFocus } = await import("../keyOwnership");
afterAll(() => { restoreGlobals(); closeDomWindow(dom); });

const doc = dom.window.document;
const PointerDown = (dom.window as any).PointerEvent ?? dom.window.MouseEvent;

function card() {
  doc.body.innerHTML = `<div id="card" tabindex="-1"><textarea id="box"></textarea><button id="copy"></button></div><span id="outside">x</span>`;
  return doc.getElementById("card") as HTMLElement;
}

// The decision card's keys (t, digits, x, p) stay live when the control
// holding focus goes away under the person: closing the answer box with
// Escape left focus on <body> and every key dead while the caps still showed.
test("focus that falls out of the card after a key inside it stays the card's", () => {
  keyScopeHasFocus(null);
  const root = card();
  const box = doc.getElementById("box")!;
  box.focus();
  box.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  box.remove();
  expect(doc.activeElement).toBe(doc.body);
  expect(keyScopeHasFocus(root)).toBe(true);
  expect(doc.activeElement).toBe(root);
});

test("a click elsewhere hands the keys back to the page", () => {
  const root = card();
  doc.getElementById("copy")!.dispatchEvent(new PointerDown("pointerdown", { bubbles: true }));
  doc.getElementById("outside")!.dispatchEvent(new PointerDown("pointerdown", { bubbles: true }));
  expect(keyScopeHasFocus(root)).toBe(false);
  expect(doc.activeElement).toBe(doc.body);
});

test("focus in another control is never claimed", () => {
  const root = card();
  doc.getElementById("copy")!.dispatchEvent(new PointerDown("pointerdown", { bubbles: true }));
  const other = doc.createElement("input");
  doc.body.appendChild(other);
  other.focus();
  expect(keyScopeHasFocus(root)).toBe(false);
});
