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
