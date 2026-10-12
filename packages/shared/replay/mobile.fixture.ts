// A PostHog mobile recording as its snapshots endpoint answers one, shaped on
// what the iOS SDK sends for a React Native (Expo) app in wireframe mode: a
// login screen, a tap on Sign in, the keyboard, a screen update to a list, a
// swipe and a console error. Synthetic: no real app's content.
import type { RrwebEvent } from "./rrweb";

const T = 1_760_000_000_000;
// A 1x1 transparent PNG, the way the SDK sends an image: bare base64.
export const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const loginScreen = {
  id: 101,
  x: 0,
  y: 0,
  width: 393,
  height: 852,
  type: "div",
  style: { backgroundColor: "#ffffff" },
  childWireframes: [
    { id: 102, x: 0, y: 0, width: 393, height: 47, type: "status_bar", style: { backgroundColor: "#ffffff" } },
    { id: 103, x: 146, y: 64, width: 100, height: 40, type: "image", base64: TINY_PNG },
    { id: 104, x: 24, y: 120, width: 345, height: 34, type: "text", text: "Welcome back", style: { color: "#111111", fontSize: 28, fontFamily: "System" } },
    { id: 105, x: 24, y: 160, width: 345, height: 20, type: "text", text: "Sign in to continue", style: { color: "#666666", fontSize: 15 } },
    { id: 106, x: 24, y: 210, width: 345, height: 48, type: "input", inputType: "email", value: "ada@example.com", disabled: false, style: { borderWidth: 1, borderColor: "#dddddd", borderRadius: 8, paddingLeft: 12 } },
    { id: 107, x: 24, y: 266, width: 345, height: 48, type: "input", inputType: "password", value: "hunter2", disabled: false, style: { borderWidth: 1, borderColor: "#dddddd", borderRadius: 8 } },
    {
      id: 108,
      x: 24,
      y: 330,
      width: 345,
      height: 52,
      type: "rectangle",
      style: { backgroundColor: "#1d4aff", borderRadius: 12 },
      childWireframes: [{ id: 109, x: 160, y: 344, width: 73, height: 24, type: "text", text: "Sign in", style: { color: "#ffffff", fontSize: 17, horizontalAlign: "center" } }],
    },
    // A color that tries to close its declaration, and a background image that is a remote URL.
    { id: 110, x: 0, y: 800, width: 393, height: 52, type: "rectangle", style: { backgroundColor: "red;background-image:url(https://evil.test/x.png)", backgroundImage: "https://evil.test/y.png" } },
  ],
};

export const ordersScreen = {
  id: 101,
  x: 0,
  y: 0,
  width: 393,
  height: 852,
  type: "div",
  style: { backgroundColor: "#f7f7f7" },
  childWireframes: [
    { id: 201, x: 24, y: 64, width: 345, height: 34, type: "text", text: "Your orders", style: { fontSize: 28 } },
    { id: 202, x: 24, y: 120, width: 345, height: 60, type: "rectangle", style: { backgroundColor: "#ffffff" }, childWireframes: [{ id: 203, x: 36, y: 138, width: 300, height: 24, type: "text", text: "Order #1042 shipped" }] },
    { id: 204, x: 24, y: 190, width: 345, height: 60, type: "rectangle", style: { backgroundColor: "#ffffff" }, childWireframes: [{ id: 205, x: 36, y: 208, width: 300, height: 24, type: "text", text: "Order #1041 delivered" }] },
    { id: 206, x: 24, y: 270, width: 345, height: 32, type: "input", inputType: "toggle", checked: true, label: "Notifications", disabled: false },
    { id: 207, x: 24, y: 320, width: 345, height: 80, type: "input", inputType: "text_area", value: "leave at the back door", disabled: false },
    { id: 208, x: 24, y: 420, width: 345, height: 44, type: "input", inputType: "button", value: "Track order", disabled: false },
    { id: 209, x: 24, y: 480, width: 345, height: 200, type: "web_view", url: "https://help.example.test/faq?token=abc" },
  ],
};

export function mobileRecording(): RrwebEvent[] {
  // Deep copies: conversion and masking change events in place.
  const copy = <V>(v: V): V => JSON.parse(JSON.stringify(v));
  return [
    { type: 4, timestamp: T, data: { href: "LoginScreen", width: 393, height: 852 } },
    { type: 2, timestamp: T + 5, data: { wireframes: [copy(loginScreen)], initialOffset: { top: 0, left: 0 } } },
    // A tap on Sign in: the SDK names no target (id 0), only the point.
    { type: 3, timestamp: T + 2_000, data: { source: 2, type: 7, id: 0, pointerType: 2, x: 196, y: 356 } },
    { type: 3, timestamp: T + 2_090, data: { source: 2, type: 9, id: 0, pointerType: 2, x: 197, y: 357 } },
    { type: 5, timestamp: T + 2_500, data: { tag: "keyboard", payload: { open: true, height: 336 } } },
    { type: 5, timestamp: T + 3_000, data: { tag: "keyboard", payload: { open: false } } },
    { type: 4, timestamp: T + 3_100, data: { href: "OrdersScreen", width: 393, height: 852 } },
    // The new screen arrives as an update of the root: its whole tree, replacing the old one.
    { type: 3, timestamp: T + 3_200, data: { source: 0, updates: [{ parentId: 0, wireframe: copy(ordersScreen) }], removes: [{ parentId: 101, id: 110 }] } },
    // A swipe down the list: a touch that moves is no tap.
    { type: 3, timestamp: T + 5_000, data: { source: 2, type: 7, id: 0, pointerType: 2, x: 200, y: 600 } },
    { type: 3, timestamp: T + 5_300, data: { source: 2, type: 9, id: 0, pointerType: 2, x: 200, y: 300 } },
    // A row added under the list.
    { type: 3, timestamp: T + 6_000, data: { source: 0, adds: [{ parentId: 101, wireframe: { id: 210, x: 24, y: 700, width: 345, height: 24, type: "text", text: "Order #1040 returned" } }] } },
    { type: 6, timestamp: T + 7_000, data: { plugin: "rrweb/console@1", payload: { level: "error", payload: ['"Order fetch failed: 500"'], trace: [] } } },
  ];
}
