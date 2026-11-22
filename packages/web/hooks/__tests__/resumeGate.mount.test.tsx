// ct-91098 / eg-2899: resumeSession (and the forced restart a silent resume
// escalates to) is a daemon command only the session's runner or second-party
// owner may send. Every web path that sends it checks the viewer first and
// sends nothing for anyone else: /threads' stall and banner resume with its
// 45s escalation (useManualResume), and /resources' Resume (resumeCommandable).

import type { Root } from "react-dom/client";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const restarts: string[] = [];
const realSessionCommands = { ...(await import("../../lib/sessionCommands")) };
mock.module("../../lib/sessionCommands", () => ({
  ...realSessionCommands,
  requestSessionRestart: async (id: string) => { restarts.push(id); },
}));

const { createRoot } = await import("react-dom/client");
const { useInboxStore, viewerCommandsSession } = await import("../../store/inboxStore");
const { useManualResume } = await import("../useManualResume");
const { resumeCommandable } = await import("../useResourceActions");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const RUNNER = "users_runner";
const OWNER = "users_owner";
const STRANGER = "users_stranger";
const CONV = "a".repeat(32);
const ROW = { _id: CONV, user_id: RUNNER, owner_user_id: OWNER };

const sent: Array<[string, string]> = [];
beforeEach(() => {
  sent.length = 0;
  restarts.length = 0;
  useInboxStore.setState({
    convCommand: async (id: string, command: string) => { sent.push([id, command]); },
    resumeSession: async (id: string) => { sent.push([id, "resumeSession"]); },
  } as any);
});

// The 45s escalation timers the hook arms, run by hand instead of waited for.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const escalations = new Map<unknown, () => void>();
(globalThis as any).setTimeout = ((fn: () => void, ms?: number) => {
  const id = realSetTimeout(ms === 45_000 ? () => {} : fn, ms === 45_000 ? 1e9 : ms);
  if (ms === 45_000) escalations.set(id, fn);
  return id;
}) as typeof setTimeout;
(globalThis as any).clearTimeout = ((id: any) => { escalations.delete(id); realClearTimeout(id); }) as typeof clearTimeout;

let resume: (() => void) | null = null;
let state = "";
function Probe({ viewer }: { viewer: string }) {
  const r = useManualResume(CONV, true, viewerCommandsSession(ROW, viewer));
  resume = () => r.handleManualResume();
  state = r.resumeState;
  return null;
}

async function pressAndEscalate(viewer: string) {
  escalations.clear();
  const root: Root = createRoot(dom.window.document.createElement("div"));
  await act(async () => root.render(<Probe viewer={viewer} />));
  await act(async () => { resume!(); });
  await act(async () => { for (const fn of [...escalations.values()]) await fn(); });
  const result = { sent: sent.map(([, c]) => c), restarts: restarts.length, state };
  await act(async () => root.unmount());
  sent.length = 0;
  restarts.length = 0;
  return result;
}

test("/threads resume: the runner and the owner send it and escalate; any other viewer sends nothing", async () => {
  expect(await pressAndEscalate(RUNNER)).toEqual({ sent: ["resumeSession"], restarts: 1, state: "sent" });
  expect(await pressAndEscalate(OWNER)).toEqual({ sent: ["resumeSession"], restarts: 1, state: "sent" });
  expect(await pressAndEscalate(STRANGER)).toEqual({ sent: [], restarts: 0, state: "idle" });
});

test("/threads resume: a viewer who loses the right while a resume is out sends no forced restart", async () => {
  escalations.clear();
  const root: Root = createRoot(dom.window.document.createElement("div"));
  await act(async () => root.render(<Probe viewer={RUNNER} />));
  await act(async () => { resume!(); });
  expect(state).toBe("sent");
  await act(async () => root.render(<Probe viewer={STRANGER} />));
  await act(async () => { for (const fn of [...escalations.values()]) await fn(); });
  expect(restarts).toEqual([]);
  await act(async () => root.unmount());
});

test("/resources Resume sends resumeSession only for sessions the viewer runs or owns", () => {
  const stranger = "b".repeat(32);
  useInboxStore.setState({
    currentUser: { _id: OWNER } as any,
    sessions: { [CONV]: ROW, [stranger]: { _id: stranger, user_id: RUNNER, owner_user_id: RUNNER } } as any,
  } as any);
  resumeCommandable([CONV, stranger, undefined], () => {});
  expect(sent).toEqual([[CONV, "resumeSession"]]);
});
