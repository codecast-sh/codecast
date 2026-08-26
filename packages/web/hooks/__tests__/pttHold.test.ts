import { describe, expect, test } from "bun:test";
import { pttHoldProps, type PushToTalk } from "../useWalkie";

// ct-44931 polish round 3. Push to talk was pointer-only, and it cancelled its
// own click — so Enter and Space did nothing on any of the four surfaces that
// carry the gesture. The keyboard chord covers exactly one of them, and only
// while that DM is the open, present tab, which left the hover card's mic and
// the receiver strip's "Hold to reply" with no keyboard path at all on any
// page. Space and Enter are how a keyboard presses a button; they now press
// this one, and letting go releases it.

function spy() {
  const calls: string[] = [];
  const ptt: PushToTalk = {
    holding: false,
    live: false,
    dropped: false,
    reason: null,
    press: () => calls.push("press"),
    release: () => calls.push("release"),
  };
  return { calls, props: pttHoldProps(ptt) };
}

const key = (over: Partial<{ key: string; repeat: boolean }> = {}) => {
  let prevented = false;
  return {
    ev: {
      key: " ",
      repeat: false,
      preventDefault: () => {
        prevented = true;
      },
      ...over,
    } as any,
    wasPrevented: () => prevented,
  };
};

describe("push to talk is a hold on the keyboard too", () => {
  test("space opens the mic and letting go closes it", () => {
    const { calls, props } = spy();
    const down = key();
    props.onKeyDown(down.ev);
    props.onKeyUp(key().ev);
    expect(calls).toEqual(["press", "release"]);
  });

  test("enter works the same — it is the other key that presses a button", () => {
    const { calls, props } = spy();
    props.onKeyDown(key({ key: "Enter" }).ev);
    props.onKeyUp(key({ key: "Enter" }).ev);
    expect(calls).toEqual(["press", "release"]);
  });

  test("space does not scroll the page out from under the sentence", () => {
    const { props } = spy();
    const down = key();
    props.onKeyDown(down.ev);
    expect(down.wasPrevented()).toBe(true);
  });

  test("auto-repeat while the key is down opens nothing a second time", () => {
    const { calls, props } = spy();
    props.onKeyDown(key().ev);
    props.onKeyDown(key({ repeat: true }).ev);
    props.onKeyDown(key({ repeat: true }).ev);
    expect(calls).toEqual(["press"]);
  });

  test("a key that is not the gesture is left alone", () => {
    const { calls, props } = spy();
    for (const k of ["a", "Tab", "Escape", "ArrowDown"]) {
      props.onKeyDown(key({ key: k }).ev);
      props.onKeyUp(key({ key: k }).ev);
    }
    expect(calls).toEqual([]);
  });

  test("the click a button fires on space is still cancelled", () => {
    // Otherwise the synthetic click keys the mic with nothing left to release
    // it — the one failure this whole gesture is built to avoid.
    const { calls, props } = spy();
    let prevented = false;
    props.onClick({ preventDefault: () => (prevented = true) } as any);
    expect(prevented).toBe(true);
    expect(calls).toEqual([]);
  });

  test("the pointer half is untouched", () => {
    const { calls, props } = spy();
    props.onPointerDown({ button: 0, preventDefault: () => {} } as any);
    props.onPointerUp();
    expect(calls).toEqual(["press", "release"]);
    // A right-click opens a context menu; it does not open a mic.
    const other = spy();
    other.props.onPointerDown({ button: 2, preventDefault: () => {} } as any);
    expect(other.calls).toEqual([]);
  });
});
