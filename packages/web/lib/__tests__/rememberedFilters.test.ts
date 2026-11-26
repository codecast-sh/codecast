import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addressNaming, encodeFilters, rememberFilters, withRemembered } from "../rememberedFilters";
import { LINK_PARAMS, focusOf, mineOf, viewOf } from "../deploys/focus";
import { useInboxStore } from "../../store/inboxStore";

const KEYS = ["mine", "show"];

describe("withRemembered", () => {
  test("a bare address opens the last filters, keeping its other parameters", () => {
    const out = withRemembered(new URLSearchParams("target=web"), KEYS, new URLSearchParams("mine=0&show=tasks"));
    expect(out.toString()).toBe("target=web&mine=0&show=tasks");
  });

  test("an address that names any filter opens as linked", () => {
    const out = withRemembered(new URLSearchParams("show=plans"), KEYS, new URLSearchParams("mine=0&show=tasks"));
    expect(out.toString()).toBe("show=plans");
  });

  test("nothing remembered, or all defaults remembered, opens the defaults", () => {
    expect(withRemembered(new URLSearchParams(""), KEYS, null).toString()).toBe("");
    expect(withRemembered(new URLSearchParams(""), KEYS, new URLSearchParams("")).toString()).toBe("");
  });
});

describe("addressNaming", () => {
  test("a bare address is rewritten to name the remembered filters, so a copy of it opens them", () => {
    expect(addressNaming("https://x.test/deploys?target=web#top", KEYS, new URLSearchParams("show=prs&mine=1"))).toBe("/deploys?target=web&mine=1&show=prs#top");
    expect(addressNaming("/deploys", KEYS, new URLSearchParams("mine=1"))).toBe("/deploys?mine=1");
  });

  test("an address that names a filter, or nothing to name, needs no rewrite", () => {
    expect(addressNaming("https://x.test/deploys?show=tasks", KEYS, new URLSearchParams("show=prs"))).toBeNull();
    expect(addressNaming("https://x.test/deploys", KEYS, null)).toBeNull();
    expect(addressNaming("https://x.test/deploys", KEYS, new URLSearchParams(""))).toBeNull();
  });
});

describe("encodeFilters", () => {
  test("a default (null) is left out, as the address leaves it out", () => {
    expect(encodeFilters({ show: "prs", mine: null })).toBe("show=prs");
    expect(encodeFilters({ show: null, mine: null })).toBe("");
  });
});

describe("rememberFilters", () => {
  beforeEach(() => useInboxStore.setState({ clientState: {}, clientStateInitialized: true, pending: {} }));
  afterEach(() => useInboxStore.setState({ clientState: {}, pending: {} }));
  const saved = () => (useInboxStore.getState().clientState.ui as { page_filters?: Record<string, string> } | undefined)?.page_filters;

  test("a pick is saved per page in address encoding, beside other pages' picks", () => {
    rememberFilters("priorities", { mine: "0", done: null });
    rememberFilters("deploys", { show: "prs", mine: "1" });
    expect(saved()).toEqual({ priorities: "mine=0", deploys: "show=prs&mine=1" });
    rememberFilters("deploys", { show: null, mine: null });
    expect(saved()).toEqual({ priorities: "mine=0", deploys: "" });
  });
});

describe("Deploys opens its view and Mine", () => {
  const open = (address: string, last: string | null) => {
    const params = new URLSearchParams(address);
    const opened = withRemembered(params, LINK_PARAMS, last === null ? null : new URLSearchParams(last));
    return { show: viewOf(opened, focusOf(params)), mine: mineOf(opened) };
  };

  test("a bare address opens the viewer's last view and Mine", () => {
    expect(open("target=web", "show=tasks&mine=1")).toEqual({ show: "tasks", mine: true });
    expect(open("", null)).toEqual({ show: "sessions", mine: false });
  });

  test("a link that names a view, Mine or a thing to focus opens as linked", () => {
    expect(open("show=prs", "show=tasks&mine=1")).toEqual({ show: "prs", mine: false });
    expect(open("mine=1", "show=tasks")).toEqual({ show: "sessions", mine: true });
    expect(open("pr=12", "show=tasks&mine=1")).toEqual({ show: "prs", mine: false });
  });
});
