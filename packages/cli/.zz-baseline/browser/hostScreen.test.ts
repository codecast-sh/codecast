/**
 * Where a headed Chrome paints on Linux: agents on a cloud host inherit a
 * daemon environment with no DISPLAY, and a headed launch there died before
 * CDP came up. It lands on the host's Xvfb when that is up, else headless.
 */

import { describe, expect, test } from "bun:test";
import { linuxDisplayPlan, SCREEN_DISPLAY, xSocketPath } from "./hostScreen.js";

const xvfbUp = (p: string) => p === "/tmp/.X11-unix/X99";
const noX = () => false;

describe("linuxDisplayPlan", () => {
  test("no DISPLAY on a host with Xvfb: the host's screen", () => {
    expect(linuxDisplayPlan({}, false, xvfbUp)).toEqual({ display: SCREEN_DISPLAY, headless: false });
  });
  test("no DISPLAY and no X server: headless instead of a launch that dies", () => {
    expect(linuxDisplayPlan({}, false, noX)).toEqual({ display: null, headless: true });
  });
  test("a desktop session's own display is left alone", () => {
    expect(linuxDisplayPlan({ DISPLAY: ":0" }, false, xvfbUp)).toEqual({ display: null, headless: false });
    expect(linuxDisplayPlan({ WAYLAND_DISPLAY: "wayland-0" }, false, noX)).toEqual({ display: null, headless: false });
  });
  test("an asked-for headless launch stays headless", () => {
    expect(linuxDisplayPlan({}, true, xvfbUp)).toEqual({ display: null, headless: true });
  });
  test("the socket path drops the colon and any screen number", () => {
    expect(xSocketPath(":99")).toBe("/tmp/.X11-unix/X99");
    expect(xSocketPath(":1.0")).toBe("/tmp/.X11-unix/X1");
  });
});
