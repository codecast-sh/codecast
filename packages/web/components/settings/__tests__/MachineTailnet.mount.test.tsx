// A machine's Tailscale state on Settings → Machines: its chip, how files from
// it reach this window's machine with the fix where there is one, and the
// "Accept direct links" switch writing through the store.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/settings/devices", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { MachineTailnet } = await import("../MachineTailnet");
const { useInboxStore } = await import("../../../store/inboxStore");
const realSetDirectLinks = useInboxStore.getState().setDeviceDirectLinks;

const net = (name: string, extra: Record<string, unknown> = {}) => ({ ip: "100.64.0.1", name: `${name}.tail1.ts.net.`, tailnet: "tail1.ts.net", ts_user_id: "42", bindable: true, ...extra });
const device = (id: string, extra: Record<string, unknown> = {}): any => ({
  device_id: id, label: id, hostname: id, platform: "darwin", last_seen: Date.now(), is_remote: false, local_project_roots: [], online: true, cli_version: "1.1.221", ...extra,
});

let root: Root;
let calls: Array<[string, boolean]> = [];
let opened: unknown[] = [];
const text = () => document.body.textContent ?? "";
const pair = () => document.querySelector("[data-pair]")?.getAttribute("data-pair") ?? null;
const links = () => [...document.querySelectorAll("a, button:not([role=switch])")].map((a) => a.textContent);

async function show(d: any, roster: any[], local: string | null = "laptop") {
  await act(async () => {
    useInboxStore.setState({
      currentUser: { _id: "u1", name: "Ada" },
      machineRoster: roster,
      localDevice: local ? { viewer: "u1", deviceId: local } : null,
      setDeviceDirectLinks: (id: string, on: boolean) => { calls.push([id, on]); },
      openSettingsModal: (section: unknown) => { opened.push(section); },
    } as any);
  });
  await act(async () => root.render(<MachineTailnet device={d} />));
}

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  calls = [];
  opened = [];
});
afterEach(async () => { await act(async () => root.unmount()); });

const laptop = device("laptop", { tailnet: net("mbp") });

test("the machine you are on without Tailscale offers the install", async () => {
  const bare = device("laptop");
  await show(bare, [bare]);
  expect(text()).toContain("No Tailscale");
  expect(links()).toContain("Install Tailscale");
  expect(pair()).toBeNull();
});

test("the machine you are on shows its tailnet name and no pair with itself", async () => {
  await show(laptop, [laptop]);
  expect(text()).toContain("Tailscale · mbp");
  expect(pair()).toBeNull();
});

test("same account: Direct, proven once a direct transfer worked", async () => {
  const desk = device("desk", { tailnet: net("desk", { ip: "100.64.0.2" }), peer_links: [{ to_device_id: "laptop", last_direct_ok_at: 5 }] });
  await show(desk, [laptop, desk]);
  expect(text()).toContain("Tailscale · desk");
  expect(pair()).toBe("direct");
  expect(document.querySelector("[aria-label=Proven]")).not.toBeNull();

  const fresh = { ...desk, peer_links: [] };
  await show(fresh, [laptop, fresh]);
  expect(pair()).toBe("direct");
  expect(document.querySelector("[aria-label=Untested]")).not.toBeNull();
});

test("another Tailscale account relays and points at switching accounts", async () => {
  const desk = device("desk", { tailnet: net("desk", { ts_user_id: "7" }) });
  await show(desk, [laptop, desk]);
  expect(pair()).toBe("relay");
  expect(text()).toContain("Relay · Other account");
  expect(links()).toContain("Switch account");
  expect(document.querySelector("a")!.getAttribute("href")).toContain("kb/1225");
});

test("another tailnet names both tailnets so the wrong one is visible", async () => {
  const desk = device("desk", { tailnet: net("desk", { tailnet: "tail9.ts.net" }) });
  await show(desk, [laptop, desk]);
  expect(text()).toContain("Relay · Other tailnet");
  const both = document.querySelector("[data-tailnets]")!.textContent!;
  expect(both).toContain("laptop tail1.ts.net");
  expect(both).toContain("desk tail9.ts.net");
  expect(links()).toContain("Switch tailnet");
});

test("a failed direct try shows its reason inline and focusable", async () => {
  const desk = device("desk", { tailnet: net("desk"), peer_links: [{ to_device_id: "laptop", last_direct_failure: { at: 5, reason: "connect ECONNREFUSED" } }] });
  await show(desk, [laptop, desk]);
  expect(text()).toContain("Relay · Last try failed");
  expect(document.querySelector("[data-reason]")!.textContent).toBe("connect ECONNREFUSED");
  expect(document.querySelector("[data-pair]")!.getAttribute("tabindex")).toBe("0");
});

test("a CLI too old to report its tailnet asks for an update, not an install", async () => {
  const old = device("desk", { cli_version: "1.1.220" });
  await show(old, [laptop, old]);
  expect(text()).toContain("Tailscale unknown");
  expect(text()).not.toContain("No Tailscale there");
  expect(links()).toContain("Update CLI on desk");
  expect(links()).not.toContain("Install Tailscale on desk");
  const update = [...document.querySelectorAll("button")].find((b) => b.textContent === "Update CLI on desk")!;
  await act(async () => update.click());
  expect(opened).toEqual(["daemon"]);

  const oldSelf = device("laptop", { cli_version: "1.1.200" });
  await show(oldSelf, [oldSelf]);
  expect(links()).toContain("Update CLI on laptop");
  expect(links()).not.toContain("Install Tailscale");
});

test("links off on the machine you are on relays every pair and turns on here", async () => {
  const offHere = { ...laptop, direct_links_off: true };
  const desk = device("desk", { tailnet: net("desk"), peer_links: [{ to_device_id: "laptop", last_direct_ok_at: 5 }] });
  await show(desk, [offHere, desk]);
  expect(text()).toContain("Relay · Links off");
  expect(document.querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe("true");
  const turnOn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Turn on here")!;
  await act(async () => turnOn.click());
  expect(calls).toEqual([["laptop", true]]);

  const deskOff = { ...desk, direct_links_off: true };
  calls = [];
  await show(deskOff, [offHere, deskOff]);
  const both = [...document.querySelectorAll("button")].find((b) => b.textContent === "Turn on both")!;
  await act(async () => both.click());
  expect(calls).toEqual([["desk", true], ["laptop", true]]);
});

test("an offline peer relays; a peer without Tailscale offers the install there", async () => {
  const desk = device("desk", { tailnet: net("desk"), online: false });
  await show(desk, [laptop, desk]);
  expect(text()).toContain("Relay · Offline");

  const bare = device("desk");
  await show(bare, [laptop, bare]);
  expect(text()).toContain("No Tailscale");
  expect(text()).not.toContain("Relay ·");
  expect(links()).toContain("Install Tailscale on desk");
});

test("userspace networking shows its state and relays", async () => {
  const desk = device("desk", { tailnet: net("desk", { bindable: false }) });
  await show(desk, [laptop, desk]);
  expect(text().match(/Userspace mode/g)).toHaveLength(1);
  expect(text()).toContain("Relay");
  expect(links()).toContain("Fix on desk");
});

test("the switch writes through the store, off and back on", async () => {
  const desk = device("desk", { tailnet: net("desk") });
  await show(desk, [laptop, desk]);
  const sw = document.querySelector("[role=switch]") as HTMLButtonElement;
  expect(sw.getAttribute("aria-checked")).toBe("true");
  await act(async () => sw.click());
  expect(calls).toEqual([["desk", false]]);

  const off = { ...desk, direct_links_off: true };
  await show(off, [laptop, off]);
  expect(document.querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe("false");
  expect(text()).toContain("Relay · Links off");
  const turnOn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Turn on")!;
  await act(async () => turnOn.click());
  expect(calls).toEqual([["desk", false], ["desk", true]]);
});

test("a plain browser shows the machine's state and switch, no pair", async () => {
  const desk = device("desk", { tailnet: net("desk") });
  await show(desk, [laptop, desk], null);
  expect(text()).toContain("Tailscale · desk");
  expect(pair()).toBeNull();
  expect(document.querySelector("[role=switch]")).not.toBeNull();
});

test("the store action flips the roster row at once", async () => {
  useInboxStore.setState({ machineRoster: [device("desk")], setDeviceDirectLinks: realSetDirectLinks } as any);
  realSetDirectLinks("desk", false);
  expect((useInboxStore.getState().machineRoster[0] as any).direct_links_off).toBe(true);
  realSetDirectLinks("desk", true);
  expect((useInboxStore.getState().machineRoster[0] as any).direct_links_off).toBeUndefined();
});
