// ct-101325: a call shrunk to floating faces must offer a way back to the
// full call that does not depend on the hover toolbar surviving a press.
// Two misses: a still press on the call strip does nothing but start a drag,
// and that press's release hides the toolbar (and its Expand) ~400 ms later
// even though the pointer never left the row.
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { ANN, ME, FloatingFaceRow, dom, entry, link, me, mount, rowOf } from "./faceRowHarness";

const proto = dom.window.HTMLElement.prototype as any;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.hasPointerCapture ??= () => false;
const Pointer = (dom.window as any).PointerEvent ?? dom.window.MouseEvent;
const bridge = { setInteractive() {}, setContentSize() {}, setDragging() {} };
const callRow = () => rowOf([me(), entry(ANN, "Ann", { state: "live-with-me", tier: "linked" })], [link(ANN, "call")]);
const pointerIn = () =>
  act(async () => {
    dom.window.document.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 0, clientY: 0 }));
  });
const stillPress = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new Pointer("pointerdown", { bubbles: true, button: 0, pointerId: 1, screenX: 100, screenY: 100 }));
    el.dispatchEvent(new Pointer("pointerup", { bubbles: true, button: 0, pointerId: 1, screenX: 100, screenY: 100 }));
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("a call shrunk to faces has a way back", () => {
  test("a still press on the call strip expands the full call", async () => {
    let opened = 0;
    const chrome = { onExpand: () => opened++, onClose() {}, closeWord: "Hide", closeTitle: "Hide" };
    const h = await mount(
      <FloatingFaceRow row={callRow()} viewerId={ME} bridge={bridge} chrome={chrome}>
        <div className="strip-body">Alexander</div>
      </FloatingFaceRow>,
    );
    await stillPress(h.q(".strip-body")!);
    await wait(5);
    expect(opened).toBe(1);
  });

  test("a still press while the pointer stays over the row leaves Expand on screen", async () => {
    const chrome = { onExpand() {}, onClose() {}, closeWord: "Hide", closeTitle: "Hide" };
    const h = await mount(
      <FloatingFaceRow row={callRow()} viewerId={ME} bridge={bridge} chrome={chrome}>
        <div className="strip-body">Alexander</div>
      </FloatingFaceRow>,
    );
    await pointerIn();
    expect(h.q('[data-chrome-btn="open"]')).not.toBeNull();
    await stillPress(h.q(".strip-body")!);
    await wait(600);
    expect(h.q('[data-chrome-btn="open"]')).not.toBeNull();
  });
});
