import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";

const { useInboxStore } = await import("../store/inboxStore");

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const MINE = { device_id: "box", label: "Linux - nose", platform: "linux", is_remote: false, is_mine: true, ssh_host: null };
let machine: unknown = MINE;
const noThrow = { ...await import("./useQueryNoThrow") };
afterAll(() => mock.module("./useQueryNoThrow", () => noThrow));
mock.module("./useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: machine }) }));

const { createRoot } = await import("react-dom/client");
const { useAttachCopy } = await import("./useAttachCopy");

function attachFor(): string {
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(<Probe />));
  const text = el.textContent ?? "";
  act(() => root.unmount());
  return text;
}
function Probe() {
  return <>{useAttachCopy("cc-x", "jx7conv").attach}</>;
}
const device = (device_id: string, tailnet?: { name: string; tailnet?: string }) => ({ device_id, label: device_id, platform: "linux", is_remote: false, last_seen: 1, online: true, ...(tailnet ? { tailnet: { ip: "100.64.0.9", tailnet: "tail1234.ts.net", ...tailnet } } : {}) });
const roster = (tailnet?: { name: string }, viewerTailnet: string | null = "tail1234.ts.net") =>
  [device("box", tailnet), device("laptop", viewerTailnet ? { name: `laptop.${viewerTailnet}.`, tailnet: viewerTailnet } : undefined)];
const viewer = { _id: "u1" } as any;

beforeEach(() => {
  machine = MINE;
  useInboxStore.setState({ machineRoster: roster({ name: "nose.tail1234.ts.net." }) as any, localDevice: { viewer: "u1", deviceId: "laptop" }, currentUser: viewer });
});

describe("useAttachCopy reaches another of your machines over its tailnet", () => {
  test("no ssh host, on a tailnet, viewed from another machine on that tailnet: ssh to the MagicDNS short name", () => {
    expect(attachFor()).toStartWith("ssh nose -t ");
  });

  test("viewed from a machine on another tailnet: ssh to the full MagicDNS name", () => {
    useInboxStore.setState({ machineRoster: roster({ name: "nose.tail1234.ts.net." }, "tail9999.ts.net") as any });
    expect(attachFor()).toStartWith("ssh nose.tail1234.ts.net -t ");
  });

  test("viewed from a machine with no tailnet: ssh to the full MagicDNS name", () => {
    useInboxStore.setState({ machineRoster: roster({ name: "nose.tail1234.ts.net." }, null) as any });
    expect(attachFor()).toStartWith("ssh nose.tail1234.ts.net -t ");
  });

  test("this window's own machine is not known yet: the local attach, since the pane may be right here", () => {
    useInboxStore.setState({ localDevice: null });
    expect(attachFor()).toStartWith("tmux -L");
  });

  test("the pane is on this window's own machine: the local attach", () => {
    useInboxStore.setState({ localDevice: { viewer: "u1", deviceId: "box" } });
    expect(attachFor()).toStartWith("tmux -L");
  });

  test("the machine reports no tailnet: the local attach", () => {
    useInboxStore.setState({ machineRoster: roster() as any });
    expect(attachFor()).toStartWith("tmux -L");
  });

  test("an ssh host the person set wins over the tailnet", () => {
    machine = { ...MINE, ssh_host: "me@nose.lan" };
    expect(attachFor()).toStartWith("ssh me@nose.lan -t ");
  });
});
