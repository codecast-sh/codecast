// The connect panel: the command is ready on arrival, and the panel says when
// the machine shows up. Only a machine that was new or offline when the panel
// opened counts; one already online then never reads as just connected.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/settings", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mints = 0;
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useMutation: () => async () => ({ token: `setup_tok_${++mints}`, expiresAt: Date.now() + 3_600_000 }),
  useAction: () => async () => null,
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, true])),
}));

const { ConnectMachine } = await import("../ConnectMachine");
const { useInboxStore } = await import("../../store/inboxStore");

const device = (id: string, online: boolean, extra: Record<string, unknown> = {}) => ({
  device_id: id, label: id, hostname: id, platform: "darwin", last_seen: Date.now(), is_remote: false, local_project_roots: [], online, ...extra,
});

let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const text = () => document.body.textContent ?? "";
const roster = (rows: any[]) => act(async () => { useInboxStore.setState({ machineRoster: rows, machineRosterLive: true } as any); });

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  mints = 0;
  useInboxStore.setState({ currentUser: { _id: "u1", name: "Ada" }, machineRoster: [device("laptop", true), device("desk", false)], machineRosterLive: true } as any);
});
afterEach(async () => { await act(async () => root.unmount()); });

test("the command is ready without a click and waits for a machine", async () => {
  await act(async () => root.render(<ConnectMachine location="test" />));
  await flush();
  expect(mints).toBe(1);
  expect(text()).toContain("curl -fsSL codecast.sh/install | sh -s -- setup_tok_1");
  expect(text()).toContain("Waiting for the machine");
});

test("a new machine coming online reads as connected; one already online does not", async () => {
  await act(async () => root.render(<ConnectMachine location="test" />));
  await flush();
  expect(text()).not.toContain("is connected");
  await roster([device("laptop", true), device("desk", false), device("server", true)]);
  expect(text()).toContain("server is connected");
});

test("an offline machine coming back reads as connected", async () => {
  await act(async () => root.render(<ConnectMachine location="test" />));
  await flush();
  await roster([device("laptop", true), device("desk", true)]);
  expect(text()).toContain("desk is connected");
});

test("reconnecting one machine waits for that one only", async () => {
  await act(async () => root.render(<ConnectMachine location="test" target={device("desk", false) as any} />));
  await flush();
  expect(text()).toContain("Waiting for desk");
  await roster([device("laptop", true), device("desk", false), device("server", true)]);
  expect(text()).toContain("Waiting for desk");
  await roster([device("laptop", true), device("desk", true), device("server", true)]);
  expect(text()).toContain("desk is connected");
});

test("a Windows machine gets the PowerShell command", async () => {
  await act(async () => root.render(<ConnectMachine location="test" target={device("pc", false, { platform: "win32" }) as any} />));
  await flush();
  expect(text()).toContain('$env:CODECAST_SETUP_TOKEN="setup_tok_1"; irm codecast.sh/install.ps1 | iex');
});
