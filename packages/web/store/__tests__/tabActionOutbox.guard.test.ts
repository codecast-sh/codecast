import "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { enqueueDispatch, loadOutbox, removeDispatch, _reopenForTests } from "../idbCache";
import { useInboxStore } from "../inboxStore";
import { makeDispatchBinding } from "../../lib/dispatchBinding";
import { storableActionArgs } from "../../lib/tabSafePath";

// The engine keeps an action's args as the caller passed them: the outbox row
// in IndexedDB and the dispatch call both carry them. A tab action handed a raw
// Evals address (a pasted /evals/f/<full id>?batch=<label>) must reach neither
// with a private identifier (evals-ui.md section 1), as the tab record does not.

await _reopenForTests({ indexedDB, IDBKeyRange });

const FULL = "7f3c2a91-0b4d-4e8a-9c1f-5d6e7a8b9c0d";
const LABEL = "playbook-old-prompt";
const RAW = `/evals/f/${FULL}?batch=${LABEL}`;
const leaks = (s: string) => s.includes(FULL) || s.includes(FULL.slice(0, 9)) || s.includes(LABEL);

const sent: Array<{ action: string; args: unknown }> = [];
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("a tab action's args reach the outbox and the dispatch call in their storable form", () => {
  beforeEach(async () => {
    for (const e of await loadOutbox()) await removeDispatch(e.id);
    sent.length = 0;
    useInboxStore.setState({ ...useInboxStore.getInitialState(), tabs: [], activeTabId: null } as any);
    const store = useInboxStore.getState() as any;
    // The real sinks: the IndexedDB writer, and a binding whose call never answers (the row stays queued, as it does in flight).
    store._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);
    store._setDispatch(makeDispatchBinding((a) => { sent.push({ action: a.action, args: a.args }); return new Promise(() => {}); }));
  });

  afterAll(() => {
    const store = useInboxStore.getState() as any;
    store._setOutbox(null, null, null);
  });

  it("openTab, updateTab and the split actions", async () => {
    const s = () => useInboxStore.getState();
    const id = s().openTab({ path: RAW, title: `Freeze ${FULL} on ${LABEL}` });
    s().updateTab(id, { path: RAW, title: RAW });
    const leaf = s().stageInsertLeaf("root", "right", RAW);
    s().stageSetLeafPath(leaf!, `/evals/s/title?batch=${LABEL}`);
    s().saveCurrentTabState({ path: RAW, title: RAW });
    await settle();

    const rows = await loadOutbox();
    const actions = rows.map((r) => r.action);
    for (const a of ["openTab", "updateTab", "stageInsertLeaf", "stageSetLeafPath"]) expect(actions).toContain(a);
    expect(leaks(JSON.stringify(rows.map((r) => r.args)))).toBe(false);
    expect(sent.length).toBeGreaterThan(0);
    expect(leaks(JSON.stringify(sent))).toBe(false);
    // The prefix and the hashed batch stay, so a replayed row still names the same page.
    expect(JSON.stringify(rows.find((r) => r.action === "openTab")!.args)).toContain(`/evals/f/${FULL.slice(0, 8)}?batch=_`);
  });

  it("a workbench's path, and nothing outside the tab actions", () => {
    expect(leaks(JSON.stringify(storableActionArgs("applyWorkbench", [{ path: RAW, zen: false }, "w1", RAW])))).toBe(false);
    // Free text elsewhere (a message quoting the link) is the author's words, never rewritten.
    const message = [{ content: `see ${RAW}` }, RAW];
    expect(storableActionArgs("sendMessage", message)).toBe(message);
    // Args with nothing to change come back as they were.
    const plain = [{ path: "/inbox", title: "Inbox" }];
    expect(storableActionArgs("openTab", plain)).toBe(plain);
  });
});
