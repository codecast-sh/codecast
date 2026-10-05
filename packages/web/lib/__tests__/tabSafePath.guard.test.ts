import { beforeEach, describe, expect, it } from "bun:test";
import { resolveEvalsBatchRef } from "@codecast/shared/contracts/evalsApi";
import { useInboxStore } from "../../store/inboxStore";
import { leafNode, sanitizeLayout, setLeafPath } from "../../store/stageSplit";
import { pathLabel } from "../pathLabel";
import { healTabPaths } from "../tabRoutes";

// The tab list persists to IndexedDB and syncs to Convex client_state, so an
// Evals address may reach it only spelled with identifiers (evals-ui.md
// section 1): no full freeze id and no batch label, through any path a tab
// or a split leaf takes in.

const FULL = "7f3c2a91-0b4d-4e8a-9c1f-5d6e7a8b9c0d";
const LABEL = "playbook-old-prompt";
const RAW = `/evals/f/${FULL}?batch=${LABEL}`;

const leaks = (s: string) => s.includes(FULL) || s.includes(FULL.slice(0, 9)) || s.includes(LABEL);

describe("an Evals path never reaches the persisted tab record with a private identifier", () => {
  beforeEach(() => {
    useInboxStore.setState({ ...useInboxStore.getInitialState(), tabs: [], activeTabId: null } as any);
  });

  it("openTab and updateTab keep the prefix and the batch hash", () => {
    const store = useInboxStore.getState();
    const id = store.openTab({ path: RAW, title: pathLabel(RAW) });
    let tab = useInboxStore.getState().tabs.find((t) => t.id === id)!;
    expect(leaks(tab.path)).toBe(false);
    expect(leaks(tab.title)).toBe(false);
    expect(tab.path.startsWith(`/evals/f/${FULL.slice(0, 8)}?batch=_`)).toBe(true);

    useInboxStore.getState().updateTab(id, { path: `/evals/s/title?batch=${LABEL}&compare=2026-10-03T00:53:31.614Z` });
    tab = useInboxStore.getState().tabs.find((t) => t.id === id)!;
    expect(leaks(tab.path)).toBe(false);
    expect(JSON.stringify(useInboxStore.getState().tabs)).not.toContain(LABEL);
  });

  it("a caller's title, and a layout written with its path, take the storable spelling too", () => {
    const id = useInboxStore.getState().openTab({ path: RAW, title: `Freeze ${FULL} on ${LABEL}` });
    let tab = useInboxStore.getState().tabs.find((t) => t.id === id)!;
    expect(leaks(tab.title)).toBe(false);
    expect(tab.title).toBe(`Freeze ${FULL.slice(0, 8)}`);

    // lib/stage.ts writes a split's layout, path and title in one patch: none of the three may carry the raw address.
    const layout = { type: "split" as const, id: "b", dir: "row" as const, sizes: [50, 50], children: [{ type: "leaf" as const, id: "l1", path: RAW }, { type: "leaf" as const, id: "l2", path: "/inbox" }] };
    useInboxStore.getState().updateTab(id, { layout, focusedLeafId: "l1", path: RAW, title: RAW });
    tab = useInboxStore.getState().tabs.find((t) => t.id === id)!;
    expect(leaks(JSON.stringify(tab))).toBe(false);
    expect(tab.layout && JSON.stringify(tab.layout)).toContain(`/evals/f/${FULL.slice(0, 8)}`);
    expect(JSON.stringify(tab.layout)).toContain('"/inbox"');

    // A tab another client persisted before the rule keeps its place, under a safe name.
    const healed = healTabPaths([{ id: "t", title: `Freeze ${FULL}`, path: RAW, createdAt: 0 }]);
    expect(leaks(JSON.stringify(healed))).toBe(false);
    // Other tabs keep the titles they were given.
    const inbox = useInboxStore.getState().openTab({ path: "/inbox", title: "My inbox" });
    expect(useInboxStore.getState().tabs.find((t) => t.id === inbox)!.title).toBe("My inbox");
  });

  it("split leaves and a hydrated tab list are healed the same way", () => {
    const leaf = leafNode(RAW, "l1");
    expect(leaks(leaf.path)).toBe(false);
    const other = leafNode("/inbox", "l2");
    const root = { type: "split" as const, id: "b", dir: "row" as const, sizes: [50, 50], children: [leaf, other] };
    expect(leaks(JSON.stringify(setLeafPath(root, "l2", RAW)))).toBe(false);
    const persisted = { type: "split", id: "b", dir: "row", sizes: [50, 50], children: [{ type: "leaf", id: "l1", path: RAW }, { type: "leaf", id: "l2", path: "/inbox" }] };
    expect(leaks(JSON.stringify(sanitizeLayout(persisted)))).toBe(false);
    const healed = healTabPaths([{ id: "t", title: "Freeze", path: RAW, createdAt: 0 }]);
    expect(leaks(healed[0].path)).toBe(false);
  });

  it("the hashed batch still resolves to the batch a page loaded", () => {
    const tab = healTabPaths([{ id: "t", title: "", path: RAW, createdAt: 0 }])[0];
    const ref = new URLSearchParams(tab.path.split("?")[1]).get("batch")!;
    expect(resolveEvalsBatchRef(ref, ["2026-10-03T00:53:31.614Z", LABEL])).toBe(LABEL);
  });

  it("leaves every other address alone", () => {
    for (const p of ["/inbox?s=abc", "/tasks/ct-1", "/docs?q=evals/f/x"]) expect(healTabPaths([{ id: "t", title: "", path: p, createdAt: 0 }])[0].path).toBe(p);
  });
});
