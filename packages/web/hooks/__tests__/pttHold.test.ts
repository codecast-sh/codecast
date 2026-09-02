import { describe, expect, test } from "bun:test";
import { talkToggleProps, type PushToTalk } from "../useWalkie";

// The talk key is a TOGGLE: one click starts the talk, the next click stops
// it. No hold, no release on the pointer leaving, no keyup — the person chose
// to talk and only they (or the engine's cap) say when it stops. What a
// keyboard does to a button (Enter, Space) fires a click, so it needs no
// handler of its own.

function spy(holding: boolean) {
  const calls: string[] = [];
  const ptt: PushToTalk = {
    holding,
    locked: false,
    live: false,
    dropped: false,
    capturing: holding,
    reason: null,
    press: () => calls.push("press"),
    release: () => calls.push("release"),
  };
  return { calls, props: talkToggleProps(ptt) };
}

const click = () => {
  let prevented = false;
  let stopped = false;
  return {
    ev: { preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) } as any,
    prevented: () => prevented,
    stopped: () => stopped,
  };
};

describe("the talk toggle", () => {
  test("a click on an idle key starts the talk", () => {
    const { calls, props } = spy(false);
    const c = click();
    props.onClick(c.ev);
    expect(calls).toEqual(["press"]);
    // The click is the gesture, so nothing behind the key gets it — the face
    // under a Talk button must not also open its own menu.
    expect(c.prevented()).toBe(true);
    expect(c.stopped()).toBe(true);
  });

  test("a click on a talking key stops it", () => {
    const { calls, props } = spy(true);
    props.onClick(click().ev);
    expect(calls).toEqual(["release"]);
  });

  test("arriving on the key warms the microphone, and nothing else", () => {
    const { calls, props } = spy(false);
    props.onPointerEnter();
    props.onFocus();
    expect(calls).toEqual([]);
  });

  test("there is no release on leaving, blurring or lifting a key", () => {
    const props = spy(true).props as Record<string, unknown>;
    for (const gone of ["onPointerUp", "onPointerLeave", "onPointerCancel", "onKeyUp", "onKeyDown"]) {
      expect(props[gone]).toBeUndefined();
    }
  });
});
