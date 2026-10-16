import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { ConvexProvider } from "convex/react";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// A page embed keeps its frame across unmounts (lib/pageFramePool): returning to a page moves the same, still loaded
// iframe back instead of loading the page again. These mount the real embed against store rows and watch the element.

const client = offlineConvexClient("https://example.convex.cloud");
const watchQuery = spyOn(client, "watchQuery").mockImplementation((() => ({
  onUpdate: () => () => {},
  localQueryResult: () => undefined,
  localQueryLogs: () => undefined,
  journal: () => undefined,
})) as never);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
// jsdom has no Element.moveBefore; a move that keeps the node is all the pool needs from it.
(dom.window.Element.prototype as any).moveBefore = function (this: Element, node: Node, child: Node | null) {
  this.insertBefore(node, child);
};
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { PublishedPageEmbed } = await import("../PublishedPageEmbed");
const { useInboxStore } = await import("../../store/inboxStore");
const { parkedFrames } = await import("../../lib/pageFramePool");

afterAll(async () => {
  watchQuery.mockRestore();
  await client.close();
  closeDomWindow(dom);
  restoreGlobals();
});

function seed(rows: Record<string, unknown>) {
  useInboxStore.setState({ pageEmbeds: { ...(useInboxStore.getState() as any).pageEmbeds, ...rows } } as any);
}

async function mount(slug: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<ConvexProvider client={client}><PublishedPageEmbed slug={slug} /></ConvexProvider>));
  const frame = () => container.querySelector("iframe");
  return {
    frame,
    unmount: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

describe("a page embed's frame outlives the embed", () => {
  test("mounting the same page again moves the same frame back", async () => {
    seed({ Same12345678: { _id: "Same12345678", slug: "Same12345678", gated: false, title: "A page", version: 2 } });
    const first = await mount("Same12345678");
    const frame = first.frame();
    expect(frame).not.toBeNull();
    await first.unmount();
    expect(frame!.isConnected).toBe(true);
    expect(parkedFrames().some((k) => k.includes("Same12345678"))).toBe(true);

    const second = await mount("Same12345678");
    expect(second.frame()).toBe(frame);
    expect(parkedFrames().some((k) => k.includes("Same12345678"))).toBe(false);
    await second.unmount();
  });

  test("two embeds of a parked page: one moves the parked frame back, the other gets a frame of its own", async () => {
    seed({ Twin12345678: { _id: "Twin12345678", slug: "Twin12345678", gated: false, title: "A page", version: 1 } });
    const first = await mount("Twin12345678");
    const parked = first.frame();
    await first.unmount();
    const a = await mount("Twin12345678");
    const b = await mount("Twin12345678");
    expect(a.frame()).toBe(parked);
    expect(b.frame()).not.toBeNull();
    expect(b.frame()).not.toBe(parked);
    const second = b.frame();
    await a.unmount();
    await b.unmount();
    // Both parked: mounted again, both come back, neither reloaded.
    const c = await mount("Twin12345678");
    const d = await mount("Twin12345678");
    expect(new Set([c.frame(), d.frame()])).toEqual(new Set([parked, second]));
    await c.unmount();
    await d.unmount();
  });

  test("a republished page gets a new frame, never the parked older version", async () => {
    seed({ Vers12345678: { _id: "Vers12345678", slug: "Vers12345678", gated: false, title: "A page", version: 1 } });
    const first = await mount("Vers12345678");
    const old = first.frame();
    await first.unmount();

    seed({ Vers12345678: { _id: "Vers12345678", slug: "Vers12345678", gated: false, title: "A page", version: 2 } });
    const second = await mount("Vers12345678");
    expect(second.frame()).not.toBe(old);
    await second.unmount();
  });

  test("a frame the gate tokens replaced is never parked under the address with them", async () => {
    // Never seen: the embed starts loading at once, without tokens. Its info then says gated, with a token, so the
    // embed moves to the tokened address; the tokenless frame (a password form) must not come back for it.
    const embed = await mount("Gate12345678");
    const tokenless = embed.frame();
    expect(tokenless?.getAttribute("src")).not.toContain("k=");
    await act(async () => seed({ Gate12345678: { _id: "Gate12345678", slug: "Gate12345678", gated: true, title: "Locked", version: 1, k: "tok", e: null } }));
    const tokened = embed.frame();
    expect(tokened?.getAttribute("src")).toContain("&k=tok");
    expect(tokened).not.toBe(tokenless);
    await embed.unmount();

    const again = await mount("Gate12345678");
    expect(again.frame()).toBe(tokened);
    await again.unmount();
  });

  test("a deleted page frames nothing, even with a frame parked for it", async () => {
    seed({ Gone12345678: { _id: "Gone12345678", slug: "Gone12345678", gated: false, title: "Soon gone", version: 1 } });
    const first = await mount("Gone12345678");
    await first.unmount();
    seed({ Gone12345678: { _id: "Gone12345678", slug: "Gone12345678", missing: true } });
    const second = await mount("Gone12345678");
    expect(second.frame()).toBeNull();
    await second.unmount();
  });
});
