// jsdom globals for mounting the composer. Imported FIRST by the test file:
// react-dom decides at load time whether the DOM exists (`canUseDOM`) and
// whether native `input` events are supported; loaded before `window` exists it
// falls back to the IE `propertychange` polling path and onChange never fires.
import { JSDOM } from "jsdom";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../../test-helpers/globals";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
export const w = dom.window as any;
export const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  localStorage: w.localStorage,
  indexedDB,
  IDBKeyRange,
  HTMLElement: w.HTMLElement,
  HTMLTextAreaElement: w.HTMLTextAreaElement,
  HTMLInputElement: w.HTMLInputElement,
  Element: w.Element,
  Node: w.Node,
  KeyboardEvent: w.KeyboardEvent,
  Event: w.Event,
  getComputedStyle: w.getComputedStyle,
  requestAnimationFrame: (cb: any) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: any) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: w.MutationObserver,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
let blobSeq = 0;
(URL as any).createObjectURL = () => `blob:test-${++blobSeq}`;
(URL as any).revokeObjectURL = () => {};
