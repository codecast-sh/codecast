import assert from "node:assert/strict";
import { test } from "bun:test";
import { resolvePageApp, type AppPermission } from "@codecast/shared/contracts/pageApp";
import { replaceGlobals } from "../../../test-helpers/globals";
import type { AppInfo, ConsentRequest } from "../../../lib/installedApps";

const info = (o: Partial<AppInfo> = {}): AppInfo => ({
  slug: "k3j2h4",
  title: "Vitals",
  version: 7,
  updated_at: 0,
  app: resolvePageApp({ name: "Vitals", permissions: ["notifications", "menu-bar", "full-access"] }, "Vitals"),
  owner: { name: "Ada" },
  icons: { "512": "data:,", "1024": "data:," },
  relation: "team",
  policy: { install: true, fullAccess: true },
  ...o,
});
const install = (i: AppInfo): ConsentRequest => ({ id: "c1", kind: "install", info: i, asked: i.app.permissions, current: [], added: i.app.permissions });

async function mount(req: ConsentRequest) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/apps/consent/c1", pretendToBeVisual: true });
  const w = dom.window as any;
  // The confirm's arming timer is held until the test fires it, so the dead half second does not depend on how fast this machine runs.
  const realSetTimeout = globalThis.setTimeout;
  const held: (() => void)[] = [];
  const setTimeoutHeld = ((f: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 500) { held.push(f); return 0 as any; }
    return (realSetTimeout as any)(f, ms, ...rest);
  }) as typeof setTimeout;
  const restore = replaceGlobals({
    setTimeout: setTimeoutHeld,
    window: w, document: w.document, navigator: w.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
    DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ConsentSheet } = await import("../ConsentSheet");
  const root = createRoot(w.document.getElementById("root"));
  const answers: { approve: boolean; grants: AppPermission[] }[] = [];
  await React.act(async () => root.render(<ConsentSheet req={req} onAnswer={(approve, grants) => answers.push({ approve, grants })} />));
  const q = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  const wait = (ms: number) => React.act(async () => { await new Promise((r) => realSetTimeout(r, ms)); });
  const arm = () => React.act(async () => { held.splice(0).forEach((f) => f()); });
  const done = async () => { await React.act(async () => root.unmount()); await wait(10); restore(); };
  return { React, q, answers, arm, done };
}

test("install: the sheet names the app and its maker, full access starts off, and the confirm installs what was left on", async () => {
  const { React, q, answers, arm, done } = await mount(install(info()));
  try {
    assert.equal(q("[data-consent-name]")!.textContent, "Vitals");
    assert.equal(q("[data-consent-owner]")!.textContent, "Ada · teammate");
    assert.equal(q('[data-permission="notifications"]')!.dataset.permissionOn, "true");
    assert.equal(q('[data-permission="full-access"]')!.dataset.permissionOn, "false");
    assert.match(q("[data-switch-confirm]")!.textContent!, /Install Vitals/);

    await React.act(async () => q('[data-permission="menu-bar"] [role=switch]')!.click());
    await React.act(async () => q('[data-permission="full-access"] [role=switch]')!.click());
    assert.equal(q('[data-permission="full-access"]')!.dataset.permissionOn, "true");
    assert.match(q('[data-switch-row="Full access"]')!.textContent!, /Any file/);

    // The confirm is dead for its first half second: a click meant for the app behind cannot land on it.
    assert.equal((q("[data-switch-confirm]") as HTMLButtonElement).disabled, true);
    q("[data-switch-confirm]")!.click();
    assert.equal(answers.length, 0);
    await arm();
    assert.equal((q("[data-switch-confirm]") as HTMLButtonElement).disabled, false);
    await React.act(async () => q("[data-switch-confirm]")!.click());
    assert.deepEqual(answers, [{ approve: true, grants: ["notifications", "full-access"] }]);
  } finally {
    await done();
  }
});

test("install: full access the team does not allow is locked with the reason, and backing out installs nothing", async () => {
  const { React, q, answers, done } = await mount(install(info({ policy: { install: true, fullAccess: false } })));
  try {
    const full = q('[data-permission="full-access"]')!;
    assert.equal(full.dataset.permissionBlock, "Off for your team");
    assert.equal(full.querySelector("[role=switch]"), null, "no switch to press");
    await React.act(async () => q("[data-switch-cancel]")!.click());
    assert.deepEqual(answers, [{ approve: false, grants: [] }]);
  } finally {
    await done();
  }
});
