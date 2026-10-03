import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";

// The role page's template sections (org-hire.md H5 to H8, H11), rendered from
// one mocked instance: the one open ask first with its guide open, Done and
// Skip on a person's open item only, what the role may do, routines with their
// trigger, what each still needs and Activate on the ready paused one only,
// the scoreboard, the release with its bindings.
async function verifyTemplateSections() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const marked: any[] = []; const activated: string[] = []; const binds: any[] = []; const proposed: any[] = [];
  const learningSet: boolean[] = []; let learningOn = false;
  const lessonRows = [{ id: "l-1", status: "released", released_in: "2.1.0", body: "The search-console step should say which account owns the property." }, { id: "l-2", status: "open", body: "The weekly review should open with the numbers." }];
  const now = Date.now();
  const instance = {
    _id: "inst-1", instance_key: "key-1", instance: "acme-growth", template_id: "growth", version: "2.0.0", digest: "6e0c187bacdef8543bba951bbad6cca098545a45be99ef6e47bc3e9b302e5e01", phase: "ready", host: { machine: "mbp", dir: "/src/acme" },
    trust: "understand", handle: "acme-growth-cmo",
    authority: [{ id: "site-write", kind: "write", label: "Ship pages", granted_at: now }, { id: "old", kind: "publish", label: "Expired", granted_at: now, expires_at: now - 1 }],
    // search-console carries the guide the host rendered at bind; measurement names one the page does not hold yet.
    setup: [{ id: "search-console", title: "Verify the domain", who: "human", status: "open", unlocks: ["seo-weekly"], price: "unlocks SEO weekly", how: "org/setup/search-console.md", guide: "# Verify acme.io\n\n1. Add the TXT record from /src/acme." }, { id: "measurement", title: "See one event", who: "role", status: "open", unlocks: [], how: "org/setup/measurement.md" }, { id: "bing", title: "Verify in Bing", who: "human", status: "done", unlocks: [] }],
    ask: { id: "search-console", title: "Verify the domain", unlocks: ["seo-weekly"] },
    readiness: { "cmo-weekly": { ready: true, mode: "propose", missing: [] }, "seo-weekly": { ready: false, mode: "propose", missing: ["evidence technical has no pass"] }, "ads-daily": { ready: true, mode: "propose", missing: ["runs as propose: trust is understand"] } },
    routines: [
      { id: "cmo-weekly", title: "CMO weekly", every: "7d", mode: "propose", trigger: { id: "tasks_1", short_id: "tr-1", status: "paused" } },
      { id: "seo-weekly", title: "SEO weekly", every: "7d", mode: "apply", trigger: { id: "tasks_2", short_id: "tr-2", status: "paused" } },
      { id: "ads-daily", title: "Ads daily", every: "1d", mode: "apply", trigger: { id: "tasks_3", short_id: "tr-3", status: "scheduled" } },
    ],
    scoreboard: [{ key: "primary_events_7d", label: "Primary events", value: "7", observed_at: now - 3_600_000, source: "ct-1" }, { key: "cost", label: "Cost per event" }],
    secrets: [{ key: "accounts.ads", label: "Google Ads credentials", bound: false }, { key: "accounts.publora", label: "Publora key", bound: true }],
    template: { name: "CMO", latest_stable: "2.1.0", changelog: "## 2.1.0\nThe search-console guide names the owning account." }, update_available: "2.1.0", update_digest: "f".repeat(64),
    // The host step from the web (H3): the machine that runs the role, and how the last request went.
    bind_host: { device: { device_id: "dev-mbp", label: "MacBook", online: true, can_receive_secrets: true, pubkey: "PUB" }, dir: "/src/acme", reason: null },
    host_step: { state: "idle" },
  };
  let shown: any = instance;
  mock.module("../../hooks/useTemplateHire", () => ({
    useTemplateInstance: () => ({ instance: shown, ready: true }),
    useTemplateCatalog: () => ({ templates: [], ready: true }),
    useTemplateActions: () => ({ propose: async (spec: any) => { proposed.push(spec); return { short_id: "op-4" }; }, setLearning: async (_team: string | undefined, enabled: boolean) => { learningSet.push(enabled); learningOn = enabled; }, markSetup: async (key: string, id: string, status: string) => { marked.push([key, id, status]); }, activate: async (id: string) => { activated.push(id); }, requestBind: async (key: string, secrets: any[]) => { binds.push([key, secrets]); return { command_id: "cmd-1", device: { device_id: "dev-mbp", label: "MacBook" }, already_pending: false }; } }),
    // Sealing is the browser's Web Crypto in the app; here the shape is what matters: never the value.
    useTemplateLearning: () => ({ learning: { enabled: learningOn, can_change: true, changed_by: null }, ready: true }),
    useInstanceLessons: () => ({ lessons: lessonRows, ready: true }),
    sealSecret: async (pubkey: string, key: string, value: string) => ({ key, payload: { provider: key, epk: `epk:${pubkey}`, iv: "iv", ct: `sealed:${value.length}` } }),
  }));
  const React = await import("react");
  const md = ({ content }: { content: string }) => React.createElement("div", { "data-md": true }, content);
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: md, MarkdownBlocks: md }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { TemplateSections } = await import("./TemplateSections");
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<TemplateSections roleId="role-1" canEdit teamId="team-1" />));
  const text = document.body.textContent!;
  assert.match(text, /Waiting on you: Verify the domain \(unlocks seo-weekly\)/);
  assert.match(text, /Allowed outside codecast: write \(Ship pages\)/);
  assert.doesNotMatch(text, /Expired/);
  assert.match(text, /Update available: 2\.1\.0/);
  // The learning switch (H12) says in one sentence what leaves and what comes back; off until a person turns it on.
  assert.match(text, /Let Codecast learn from this workspace's template roles/);
  assert.match(text, /never transcripts, quotes, names, customer data or code/);
  const learning = () => document.querySelector<HTMLInputElement>('[data-template-learning] input[role="switch"]')!;
  assert.equal(learning().checked, false);
  assert.equal(document.querySelector("[data-template-learning]")!.getAttribute("data-template-learning"), "false");
  await act(async () => learning().click());
  assert.deepEqual(learningSet, [true]);
  // The lessons that left this workspace, with where each stands.
  assert.equal(document.querySelectorAll("[data-template-lesson]").length, 2);
  assert.match(text, /released in 2\.1\.0The search-console step should say which account owns the property\./);
  // Update: one proposal the person decides, pinning the stable release; the host step performs it after.
  await act(async () => document.querySelector<HTMLButtonElement>("[data-template-update-propose]")!.click());
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0].changes, [{ kind: "upgrade", instance: "acme-growth", template: "growth", to: "2.1.0", digest: "f".repeat(64) }]);
  assert.equal(proposed[0].team_id, "team-1");
  assert.match(proposed[0].summary_md, /names the owning account/);
  assert.match(document.body.textContent!, /proposed: op-4/);
  assert.equal(document.querySelector("[data-template-update-propose]"), null);
  assert.match(text, /Google Ads credentials: missing/);
  assert.match(text, /Publora key: set/);
  assert.match(text, /Primary events7/);
  const states = [...document.querySelectorAll<HTMLElement>("[data-template-routine]")].map((el) => [el.dataset.templateRoutine, el.dataset.state]);
  assert.deepEqual(states, [["cmo-weekly", "paused, ready"], ["seo-weekly", "paused, not ready"], ["ads-daily", "active"]]);
  const buttons = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === label);
  // Each routine names its trigger, linked to the trigger's page.
  assert.deepEqual([...document.querySelectorAll<HTMLAnchorElement>("[data-template-trigger]")].map((a) => [a.textContent, a.getAttribute("href")]), [["tr-1", "/triggers/tr-1"], ["tr-2", "/triggers/tr-2"], ["tr-3", "/triggers/tr-3"]]);
  // The one open ask shows its guide, with this instance's values, without a click; the others stay folded.
  const guide = (id: string) => document.querySelector<HTMLElement>(`[data-template-guide="${id}"]`);
  assert.match(guide("search-console")!.textContent!, /Verify acme\.io.*Add the TXT record from \/src\/acme/s);
  assert.equal(guide("measurement"), null);
  assert.equal(document.querySelector('[data-template-guide-toggle="bing"]'), null, "no guide in the release: no toggle");
  // A step whose guide has not reached the page says where it is and how to get it.
  await act(async () => document.querySelector<HTMLButtonElement>('[data-template-guide-toggle="measurement"]')!.click());
  assert.match(guide("measurement")!.textContent!, /Ask @acme-growth-cmo for it, or run there: cast org template instructions acme-growth setup:measurement/);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-template-guide-toggle="search-console"]')!.click());
  assert.equal(guide("search-console"), null, "a person can fold the open ask's guide");
  // Done and Skip only on the person's open item; Reopen on the one they closed; Activate only on the ready paused routine.
  assert.equal(buttons("Done").length, 1);
  assert.equal(buttons("Skip").length, 1);
  assert.equal(buttons("Reopen").length, 1);
  assert.equal(buttons("Activate").length, 1);
  await act(async () => buttons("Done")[0]!.click());
  await act(async () => buttons("Skip")[0]!.click());
  await act(async () => buttons("Reopen")[0]!.click());
  assert.deepEqual(marked, [["key-1", "search-console", "done"], ["key-1", "search-console", "skipped"], ["key-1", "bing", "open"]]);
  await act(async () => buttons("Activate")[0]!.click());
  assert.deepEqual(activated, ["tasks_1"]);
  // Ready with a missing secret: the page binds it from here, sealed to the machine's key, never as a value.
  assert.ok(document.querySelector('[data-host-purpose="secrets"]'));
  // The terminal form stays, folded: the page never leads with a command.
  assert.match(document.querySelector("details")!.textContent!, /cast org template bind acme-growth --secret accounts\.ads=<path>/);
  const type = async (selector: string, value: string) => {
    const el = document.querySelector<HTMLTextAreaElement>(selector)!;
    assert.ok(el, selector);
    await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const run = () => document.querySelector<HTMLButtonElement>("[data-host-run]")!;
  assert.equal(run().disabled, true, "nothing typed: nothing to bind");
  // A masked textarea, never a password input: a password input strips line breaks, which breaks a pasted PEM key.
  const field = document.querySelector<HTMLTextAreaElement>('textarea[name="secret:accounts.ads"]')!;
  assert.equal(field.tagName, "TEXTAREA");
  await type('textarea[name="secret:accounts.ads"]', "{\"token\":\n\"never-copied\"}");
  assert.equal(run().textContent, "Bind on MacBook");
  await act(async () => run().click());
  assert.equal(binds.length, 1);
  assert.equal(binds[0][0], "key-1");
  assert.deepEqual(binds[0][1], [{ key: "accounts.ads", payload: { provider: "accounts.ads", epk: "epk:PUB", iv: "iv", ct: "sealed:25" } }]); // the line break survives into what is sealed
  assert.doesNotMatch(JSON.stringify(binds), /never-copied/);
  await act(async () => root.unmount());
  // Awaiting its host: one button, the machine named, progress and failure read from the record.
  const rerender = async (patch: any) => { shown = { ...instance, ...patch }; await act(async () => root2.render(<TemplateSections key={JSON.stringify(patch)} roleId="role-1" canEdit teamId="team-1" />)); return document.body.textContent!; };
  const root2 = createRoot(document.getElementById("root")!);
  // Skipped: the record's ask is the next open step, and the page follows it, opening that step's guide instead.
  let body = await rerender({ setup: [{ ...instance.setup[0]!, status: "skipped" }, instance.setup[1]!, { id: "publora", title: "Connect Publora", who: "human", status: "open", unlocks: ["social"], how: "org/setup/publora.md", guide: "Open Publora and connect the accounts." }], ask: { id: "publora", title: "Connect Publora", unlocks: ["social"] } });
  assert.match(body, /Waiting on you: Connect Publora \(unlocks social\)/);
  assert.doesNotMatch(body, /Waiting on you: Verify the domain/);
  assert.equal(document.querySelector('[data-template-setup-item="search-console"]')!.getAttribute("data-status"), "skipped");
  assert.equal(guide("search-console"), null);
  assert.match(guide("publora")!.textContent!, /Open Publora/);
  assert.equal(buttons("Skip").length, 1);
  assert.equal(buttons("Reopen").length, 1);
  body = await rerender({ setup: instance.setup.map((s) => ({ ...s, status: s.who === "human" ? "skipped" : "done" })), ask: undefined });
  assert.match(body, /Nothing is left open\. A skipped step can be reopened\./);
  // An accepted update: the same button runs the host step, moving the instance to the release.
  body = await rerender({ pending_upgrade: { to: "2.1.0", digest: "f".repeat(64) }, secrets: [] });
  assert.match(body, /Update available: 2\.1\.0 \(accepted; its machine moves it on the next host step\)/);
  assert.equal(document.querySelector("[data-template-update-propose]"), null);
  assert.equal(run().textContent, "Move to 2.1.0 on MacBook");
  assert.match(document.querySelector('[data-host-purpose="update"] details')!.textContent!, /cast org template bind acme-growth --to 2\.1\.0/);
  body = await rerender({ phase: "awaiting_host", secrets: [{ key: "accounts.ads", label: "Google Ads credentials", bound: false }] });
  assert.match(body, /Its machine still has to install the template/);
  assert.equal(run().textContent, "Set up on MacBook");
  assert.equal(run().disabled, false, "a secret may be left blank and added later");
  assert.match(body, /online · \/src\/acme/);
  assert.match(body, /Prefer the terminal\?/);
  await act(async () => run().click());
  assert.deepEqual(binds[1], ["key-1", []]);
  body = await rerender({ phase: "awaiting_host", host_step: { state: "pending", device_label: "MacBook" } });
  assert.match(body, /Setting up on MacBook…/);
  assert.equal(document.querySelector("[data-host-run]"), null, "no second request while one runs");
  body = await rerender({ phase: "awaiting_host", host_step: { state: "failed", device_label: "MacBook", error: "Instance is proposal; reconcile first" } });
  assert.match(body, /MacBook: Instance is proposal; reconcile first/);
  assert.equal(run().textContent, "Try again on MacBook");
  body = await rerender({ phase: "awaiting_host", bind_host: { device: null, dir: null, reason: "No machine has run codecast for this workspace's host recently." } });
  assert.match(body, /No machine has run codecast/);
  assert.equal(document.querySelector("[data-host-run]"), null);
  body = await rerender({ phase: "awaiting_host", bind_host: { ...instance.bind_host, device: { ...instance.bind_host.device, can_receive_secrets: false, pubkey: null } } });
  await type('textarea[name="secret:accounts.ads"]', "x");
  assert.match(document.body.textContent!, /too old to receive a secret/);
  assert.equal(run().disabled, true);
  await act(async () => root2.unmount());
  closeDomWindow(dom);
  console.log("template sections mount: passed");
}

if (import.meta.main) await verifyTemplateSections();
