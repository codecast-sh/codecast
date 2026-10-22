import { useState, type RefObject } from "react";

// React mirrors a controlled textarea's value into its defaultValue, and a
// textarea's defaultValue is its text node, so every keystroke replaced a
// child in the DOM. On a page with :has() rules, a tree change makes the
// browser re-check them across the page: 60 ms a key beside a long transcript
// (2026-10-22), where changing only the value costs under 1 ms.
//
// Giving the element its own defaultValue that reads back the live value makes
// React's "has it changed" check come out equal, so React never writes the
// text node. The node keeps whatever text the box mounted with, which nothing
// shows: once a box has been edited, its value is what renders.
export function holdTextareaTextNode(el: HTMLTextAreaElement | null): void {
  if (!el || Object.prototype.hasOwnProperty.call(el, "defaultValue")) return;
  Object.defineProperty(el, "defaultValue", {
    configurable: true,
    get: () => el.value,
    set: () => {},
  });
}

/** A drop-in for useRef<HTMLTextAreaElement>(null) on a controlled textarea:
 *  React's assignment of the element holds its text node. */
export function useHeldTextareaRef(): RefObject<HTMLTextAreaElement | null> {
  return useState(() => {
    let el: HTMLTextAreaElement | null = null;
    return {
      get current() { return el; },
      set current(next: HTMLTextAreaElement | null) { holdTextareaTextNode(next); el = next; },
    };
  })[0];
}
