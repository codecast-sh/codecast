import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter, useLocation } from "react-router";
import { composeHandoffPrompt } from "@codecast/shared/contracts";
import { parseSessionHandoff } from "../../lib/sessionHandoff";
import { HandoffLinkChip, SessionHandoffCard, SessionHandoffNotice } from "../conversation/SessionHandoff";
import { classifyUserMessage, FOLD_KEPT_USER_KINDS, isStickyWorthy } from "../conversation/classify";
import { useInboxStore } from "../../store/inboxStore";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { paneSessionId } from "../../lib/stage";

const source = { short_id: "jx7fchg", title: "Landing page design", agent_type: "claude_code", model: "fable", message_count: 143 };
const details = { ...source, conversation_id: "source-conversation" };
const navigation = { convLink: (id: string) => `/conversation/${id}`, navigateToSession: () => {} };
const brief = `## Goal\n\nFinish the **landing page**.\n\n## Decisions\n\n${"- Preserve the design and its spacing.\n".repeat(140)}\n## Next steps\n\n1. Verify the logo.`;
const prompt = composeHandoffPrompt({ source, brief, direction: "Verify before publishing." });
const handoff = parseSessionHandoff(prompt)!;
const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

function CurrentLocation() {
  const location = useLocation();
  return <output>{location.pathname}{location.search}</output>;
}

describe("session handoff rendering", () => {
  test("a generated brief is a handoff in full and folded views, never a sticky human prompt", () => {
    const kind = classifyUserMessage({ _id: "seed", role: "user", content: `<pasted_content id="seed">${prompt}</pasted_content>`, timestamp: 1 });
    expect(kind.kind).toBe("session_handoff");
    expect(FOLD_KEPT_USER_KINDS.has(kind.kind)).toBe(true);
    expect(isStickyWorthy(kind)).toBe(false);
  });

  test("long handoff briefs render markdown and put transcript commands behind a disclosure", () => {
    const html = render(<SessionHandoffCard handoff={handoff} source={details} timestamp={Date.now()} {...navigation} />);
    expect(html).toContain('data-session-handoff="incoming"');
    expect(html).toContain('href="/conversation/source-conversation"');
    expect(html).toContain("Landing page design");
    expect(html).toContain("<h2>Goal</h2>");
    expect(html).toContain("<strong>landing page</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("Verify before publishing.");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Transcript &amp; context");
    expect(html).not.toContain("This session continues that work");
  });

  test("header and outgoing notice name the session instead of displaying its id", () => {
    for (const node of [<HandoffLinkChip key="chip" details={details} direction="from" {...navigation} />, <SessionHandoffNotice key="notice" details={details} {...navigation} />]) {
      const html = render(node);
      expect(html).toContain("Landing page");
      expect(html).not.toContain("jx7fchg");
      expect(html).toContain('href="/conversation/source-conversation"');
    }
    expect(render(<SessionHandoffNotice details={details} {...navigation} />)).toContain("Handed off to");
  });

  test("older handoffs still link to their source before metadata is loaded", () => {
    const html = render(<SessionHandoffCard handoff={handoff} timestamp={Date.now()} {...navigation} />);
    expect(html).toContain('href="/conversation/jx7fchg?handoff=1"');
    expect(paneSessionId("/conversation/jx7fchg?handoff=1")).toBeNull();
    expect(html).toContain("Landing page design");
  });

  test("links follow live short titles, navigate on plain clicks, and preserve modified clicks", async () => {
    const dom = new JSDOM("<div id='root'></div>", { url: "https://app.test/inbox" });
    const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(dom.window.document.getElementById("root")!);
    const visited: string[] = [];
    try {
      await act(async () => root.render(<MemoryRouter><HandoffLinkChip details={details} direction="from" convLink={navigation.convLink} navigateToSession={id => visited.push(id)} /></MemoryRouter>));
      const link = dom.window.document.querySelector("a")!;
      expect(link.textContent).toContain("Landing page");
      await act(async () => {
        useInboxStore.getState().syncTable("sessions", [{ _id: details.conversation_id, session_id: "handoff-test", title: "Updated landing page", short_title: "Landing polish", agent_type: "codex", updated_at: Date.now() }], { isDelta: true });
        flushSyncPublishes();
      });
      expect(link.textContent).toContain("Landing polish");
      expect(link.title).toBe("Updated landing page");
      await act(async () => link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
      expect(visited).toEqual([details.conversation_id]);
      let modifiedWasPrevented: boolean | undefined;
      dom.window.addEventListener("click", e => { modifiedWasPrevented = e.defaultPrevented; e.preventDefault(); }, { once: true });
      await act(async () => link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true })));
      expect(modifiedWasPrevented).toBe(false);
      expect(visited).toEqual([details.conversation_id]);
      await act(async () => root.render(<MemoryRouter><HandoffLinkChip details={{ ...details, conversation_id: source.short_id }} direction="from" convLink={navigation.convLink} navigateToSession={id => visited.push(id)} /><CurrentLocation /></MemoryRouter>));
      await act(async () => dom.window.document.querySelector("a")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
      expect(dom.window.document.querySelector("output")!.textContent).toBe(`/conversation/${source.short_id}?handoff=1`);
      expect(visited).toEqual([details.conversation_id]);
    } finally {
      await act(async () => root.unmount());
      useInboxStore.getState().pruneGhostSessions([details.conversation_id]);
      closeDomWindow(dom);
      restore();
    }
  });
});
