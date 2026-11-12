import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chipBucketFilters, chipMatchesSession, chipProjectFilters, useInboxStore } from "../inboxStore";
import { convexId, session } from "./bucketFixtures";

describe("toggleBucketFilterTerm (shift-click filter list)", () => {
  const resetFilters = () => {
    useInboxStore.setState({
      activeBucketFilter: null,
      extraBucketFilters: [],
      activeProjectFilter: null,
      activeProjectPath: null,
      chipFilterExclude: false,
      pending: {},
    });
  };
  beforeEach(resetFilters);
  afterEach(resetFilters);
  const filters = () => chipBucketFilters(useInboxStore.getState());

  it("the first term behaves like a plain/alt click, clearing the project axis", () => {
    const store = useInboxStore.getState();
    store.setActiveProjectFilter("codecast", "/x/codecast");
    store.toggleBucketFilterTerm("b1", false);
    const st = useInboxStore.getState();
    expect(st.activeBucketFilter).toBe("b1");
    expect(st.activeProjectFilter).toBeNull();
    expect(filters()).toEqual([{ id: "b1", exclude: false }]);
  });

  it("appends terms in click order and removes them on a same-polarity re-toggle", () => {
    const store = useInboxStore.getState();
    store.toggleBucketFilterTerm("b1", false);
    store.toggleBucketFilterTerm("b2", false);
    store.toggleBucketFilterTerm("b3", true);
    expect(filters()).toEqual([
      { id: "b1", exclude: false },
      { id: "b2", exclude: false },
      { id: "b3", exclude: true },
    ]);
    store.toggleBucketFilterTerm("b2", false);
    expect(filters()).toEqual([{ id: "b1", exclude: false }, { id: "b3", exclude: true }]);
  });

  it("an opposite-polarity toggle flips a term in place (head and tail)", () => {
    const store = useInboxStore.getState();
    store.toggleBucketFilterTerm("b1", false);
    store.toggleBucketFilterTerm("b2", false);
    store.toggleBucketFilterTerm("b2", true);
    expect(filters()).toEqual([{ id: "b1", exclude: false }, { id: "b2", exclude: true }]);
    store.toggleBucketFilterTerm("b1", true);
    expect(useInboxStore.getState().chipFilterExclude).toBe(true);
    expect(filters()).toEqual([{ id: "b1", exclude: true }, { id: "b2", exclude: true }]);
  });

  it("removing the head promotes the first extra so extras never outlive the head", () => {
    const store = useInboxStore.getState();
    store.toggleBucketFilterTerm("b1", false);
    store.toggleBucketFilterTerm("b2", true);
    store.toggleBucketFilterTerm("b1", false);
    const st = useInboxStore.getState();
    expect(st.activeBucketFilter).toBe("b2");
    expect(st.chipFilterExclude).toBe(true);
    expect(st.extraBucketFilters).toEqual([]);
    store.toggleBucketFilterTerm("b2", true);
    expect(useInboxStore.getState().activeBucketFilter).toBeNull();
    expect(filters()).toEqual([]);
  });

  it("a plain click (setActiveBucketFilter) collapses a multi-term filter to one chip", () => {
    const store = useInboxStore.getState();
    store.toggleBucketFilterTerm("b1", false);
    store.toggleBucketFilterTerm("b2", false);
    store.setActiveBucketFilter("b2");
    expect(filters()).toEqual([{ id: "b2", exclude: false }]);
  });

  it("history restore: setActiveBucketFilter with extras re-applies a full list at once", () => {
    const store = useInboxStore.getState();
    store.setActiveBucketFilter("b2", true, [{ id: "b3", exclude: false }, { id: "b4", exclude: true }]);
    expect(filters()).toEqual([
      { id: "b2", exclude: true },
      { id: "b3", exclude: false },
      { id: "b4", exclude: true },
    ]);
    // Extras never survive a cleared head.
    store.setActiveBucketFilter(null, false, [{ id: "b3", exclude: false }]);
    expect(useInboxStore.getState().extraBucketFilters).toEqual([]);
  });

  it("picking a project clears the whole label list", () => {
    const store = useInboxStore.getState();
    store.toggleBucketFilterTerm("b1", false);
    store.toggleBucketFilterTerm("b2", true);
    store.setActiveProjectFilter("codecast", "/x/codecast");
    expect(filters()).toEqual([]);
    expect(useInboxStore.getState().extraBucketFilters).toEqual([]);
  });
});

describe("toggleProjectFilterTerm (shift-click on project chips)", () => {
  const resetFilters = () => {
    useInboxStore.setState({
      activeBucketFilter: null,
      extraBucketFilters: [],
      activeProjectFilter: null,
      activeProjectPath: null,
      extraProjectFilters: [],
      chipFilterExclude: false,
      pending: {},
    });
  };
  beforeEach(resetFilters);
  afterEach(resetFilters);
  const filters = () => chipProjectFilters(useInboxStore.getState());

  it("the first term behaves like a plain/alt click, clearing the label axis", () => {
    const store = useInboxStore.getState();
    store.toggleBucketFilterTerm("b1", false);
    store.toggleBucketFilterTerm("b2", true);
    store.toggleProjectFilterTerm("web", "/x/web", false);
    const st = useInboxStore.getState();
    expect(st.activeProjectFilter).toBe("web");
    expect(st.activeProjectPath).toBe("/x/web");
    expect(st.activeBucketFilter).toBeNull();
    expect(st.extraBucketFilters).toEqual([]);
    expect(filters()).toEqual([{ id: "web", path: "/x/web", exclude: false }]);
  });

  it("appends, flips, removes, and promotes exactly like the label list", () => {
    const store = useInboxStore.getState();
    store.toggleProjectFilterTerm("web", "/x/web", false);
    store.toggleProjectFilterTerm("cli", "/x/cli", false);
    store.toggleProjectFilterTerm("docs", "/x/docs", true);
    expect(filters()).toEqual([
      { id: "web", path: "/x/web", exclude: false },
      { id: "cli", path: "/x/cli", exclude: false },
      { id: "docs", path: "/x/docs", exclude: true },
    ]);
    store.toggleProjectFilterTerm("cli", "/x/cli", true);
    expect(filters()[1]).toEqual({ id: "cli", path: "/x/cli", exclude: true });
    // Removing the head promotes the first extra, path and polarity included.
    store.toggleProjectFilterTerm("web", "/x/web", false);
    const st = useInboxStore.getState();
    expect(st.activeProjectFilter).toBe("cli");
    expect(st.activeProjectPath).toBe("/x/cli");
    expect(st.chipFilterExclude).toBe(true);
    expect(st.extraProjectFilters).toEqual([{ id: "docs", path: "/x/docs", exclude: true }]);
    store.toggleProjectFilterTerm("cli", "/x/cli", true);
    store.toggleProjectFilterTerm("docs", "/x/docs", true);
    expect(filters()).toEqual([]);
    expect(useInboxStore.getState().chipFilterExclude).toBe(false);
  });

  it("a plain click collapses the list; a label click clears it; history restores it whole", () => {
    const store = useInboxStore.getState();
    store.toggleProjectFilterTerm("web", "/x/web", false);
    store.toggleProjectFilterTerm("cli", "/x/cli", false);
    store.setActiveProjectFilter("cli", "/x/cli");
    expect(filters()).toEqual([{ id: "cli", path: "/x/cli", exclude: false }]);
    store.toggleProjectFilterTerm("web", "/x/web", false);
    store.setActiveBucketFilter("b1");
    expect(filters()).toEqual([]);
    expect(useInboxStore.getState().extraProjectFilters).toEqual([]);
    store.setActiveProjectFilter("web", "/x/web", true, [{ id: "cli", path: "/x/cli", exclude: false }]);
    expect(filters()).toEqual([
      { id: "web", path: "/x/web", exclude: true },
      { id: "cli", path: "/x/cli", exclude: false },
    ]);
    store.setActiveProjectFilter(null, null, false, [{ id: "cli", path: "/x/cli", exclude: false }]);
    expect(useInboxStore.getState().extraProjectFilters).toEqual([]);
  });

  it("a multi-project include list is a union; the matcher is the label matcher", () => {
    const bucketByConv = {} as Record<string, string | undefined>;
    const web = session(convexId("w"), { project_path: "/x/web" });
    const cli = session(convexId("c"), { project_path: "/x/cli" });
    const docs = session(convexId("d"), { project_path: "/x/docs" });
    const terms = [
      { id: "web", path: "/x/web", exclude: false },
      { id: "cli", path: "/x/cli", exclude: false },
    ];
    expect(chipMatchesSession(web, { projectFilters: terms, bucketByConv })).toBe(true);
    expect(chipMatchesSession(cli, { projectFilters: terms, bucketByConv })).toBe(true);
    expect(chipMatchesSession(docs, { projectFilters: terms, bucketByConv })).toBe(false);
    const hideBoth = terms.map((t) => ({ ...t, exclude: true }));
    expect(chipMatchesSession(web, { projectFilters: hideBoth, bucketByConv })).toBe(false);
    expect(chipMatchesSession(docs, { projectFilters: hideBoth, bucketByConv })).toBe(true);
  });
});
