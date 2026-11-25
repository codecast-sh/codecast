import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push() {}, replace() {}, back() {}, prefetch() {} }), usePathname: () => "/inbox", useSearchParams: () => new URLSearchParams() }));
const realActions = { ...(await import("../../lib/paletteActions")) };
let scoreCalls = 0;
mock.module("../../lib/paletteActions", () => ({ ...realActions, paletteItemScore: (v: string, s: string, k?: string[]) => { scoreCalls++; return (realActions.paletteItemScore as any)(v, s, k); } }));
const realRank = { ...(await import("../../lib/instantSessionSearch")) };
let rankMs = 0, rankCalls = 0;
mock.module("../../lib/instantSessionSearch", () => ({ ...realRank, rankSessions: (...a: any[]) => { const t = performance.now(); rankCalls++; try { return (realRank.rankSessions as any)(...a); } finally { rankMs += performance.now() - t; } } }));
let scrolls = 0;
w.HTMLElement.prototype.scrollIntoView = function () { scrolls++; };
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
const SESSIONS = Number(process.env.N ?? 7000);
function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}
function syntheticSessions(n: number) {
  const out: Record<string, any> = {}; const now = Date.now();
  for (let i = 0; i < n; i++) { const id = `jx7${String(i).padStart(29, "0")}`; out[id] = { _id: id, session_id: `s-${i}`, title: `Session ${i} fixing the auth race`, user_id: "u1", agent_type: "claude_code", status: i % 9 ? "completed" : "active", is_idle: i % 9 !== 0, message_count: 20, updated_at: now - i * 60_000, started_at: now - i * 120_000, project_path: `/src/p${i % 40}` }; }
  return out;
}
let input: HTMLInputElement;
beforeAll(async () => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: syntheticSessions(SESSIONS), currentUser: { _id: "u1", name: "T" } } as any);
  const { CommandPalette } = await import("../CommandPalette");
  const c = w.document.createElement("div"); w.document.body.appendChild(c);
  const root = createRoot(c);
  await act(async () => { root.render(<ConvexProvider client={fakeConvex()}><CommandPalette standalone /></ConvexProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  input = c.querySelector("input[cmdk-input]") as HTMLInputElement;
});
function typeChar(ch: string) {
  const k = Object.keys(input).find((k) => k.startsWith("__reactProps"))!;
  const props = (input as any)[k];
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(input, input.value + ch);
  props.onChange?.({ target: input, currentTarget: input, nativeEvent: new w.Event("input") });
}
test("explore", async () => {
  expect(input).toBeTruthy();
  for (const ch of (process.env.Q ?? "session")) {
    scoreCalls = 0; scrolls = 0; rankMs = 0; rankCalls = 0;
    const t0 = performance.now();
    await act(async () => { typeChar(ch); });
    console.log(ch, Math.round(performance.now() - t0), "ms score", scoreCalls, "scroll", scrolls, "rank", rankCalls, Math.round(rankMs), "items", w.document.querySelectorAll("[cmdk-item]").length);
  }
});
