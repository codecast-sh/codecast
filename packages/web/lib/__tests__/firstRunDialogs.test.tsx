import { afterEach, beforeAll, describe, expect, test } from "bun:test";

// Two first-run dialogs on the same first visit used to stack: the device
// setup card opened when the permission read landed, and the inbox tour's
// modal dropped over it a beat later. Each auto-opens on its own clock and
// knew nothing of the other. This mounts two dialogs shaped like them — an
// effect that opens as soon as it wants to and is not blocked — and asserts
// only one is ever open, and that the second follows once the first closes.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/inbox" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetFirstRunDialogsForTests, useFirstRunDialog } from "../firstRunDialogs";

import { useWatchEffect } from "../../hooks/useWatchEffect";
const opened: Record<string, boolean> = {};
const closers: Record<string, () => void> = {};

// Shaped like the real ones: opens unasked once, and a close marks it seen.
function FirstRunDialog({ id, wants }: { id: string; wants: boolean }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  const { blocked, claim } = useFirstRunDialog(id, open);
  useWatchEffect(() => {
    if (wants && !seen && !open && !blocked && claim()) setOpen(true);
  }, [wants, seen, open, blocked, claim]);
  opened[id] = open;
  closers[id] = () => {
    setSeen(true);
    setOpen(false);
  };
  return open ? <div data-dialog={id} /> : null;
}

let root: Root;
let container: HTMLElement;

beforeAll(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  resetFirstRunDialogsForTests();
  for (const k of Object.keys(opened)) delete opened[k];
});

function mount(el: React.ReactElement) {
  root = createRoot(container);
  act(() => root.render(el));
}

describe("first-run dialogs take turns", () => {
  test("both want to open at once: only one does, the other follows when it closes", () => {
    mount(<><FirstRunDialog id="device-setup" wants /><FirstRunDialog id="tour" wants /></>);
    // Whichever effect ran first holds the turn; exactly one is open.
    expect(Number(opened["device-setup"]) + Number(opened["tour"])).toBe(1);
    expect(container.querySelectorAll("[data-dialog]").length).toBe(1);

    const first = opened["device-setup"] ? "device-setup" : "tour";
    const second = first === "tour" ? "device-setup" : "tour";
    act(() => closers[first]());
    expect(opened[first]).toBe(false);
    expect(opened[second]).toBe(true);
    expect(container.querySelectorAll("[data-dialog]").length).toBe(1);
  });

  test("a dialog that starts wanting later waits for the open one", () => {
    function Rig() {
      const [tourWants, setTourWants] = useState(false);
      (closers as any).wantTour = () => setTourWants(true);
      return <><FirstRunDialog id="device-setup" wants /><FirstRunDialog id="tour" wants={tourWants} /></>;
    }
    mount(<Rig />);
    expect(opened["device-setup"]).toBe(true);
    act(() => (closers as any).wantTour());
    expect(opened["tour"]).toBe(false);
    act(() => closers["device-setup"]());
    expect(opened["tour"]).toBe(true);
  });

  test("a closed dialog releases the turn for everyone", () => {
    mount(<><FirstRunDialog id="a" wants /><FirstRunDialog id="b" wants={false} /></>);
    expect(opened["a"]).toBe(true);
    act(() => closers["a"]());
    act(() => root.unmount());
    resetFirstRunDialogsForTests();
    mount(<FirstRunDialog id="b" wants />);
    expect(opened["b"]).toBe(true);
  });
});
