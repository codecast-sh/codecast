import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { replaceGlobals } from "../../../test-helpers/globals";

const { JSDOM } = require("jsdom");
const originalPath = "/conversation/original";
const projectPath = "/projects/linear-project";
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: `https://app.test${originalPath}`,
});
const restore = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { useInboxStore } = await import("../../../store/inboxStore");
useInboxStore.getState()._setDispatch(async () => null);
const { IssueSyncSources } = await import("../IssueSyncSources");
const client = new ConvexReactClient("https://unused.convex.cloud");
const root = createRoot(document.getElementById("root")!);

function Screen() {
  const path = useInboxStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.path);
  const section = useInboxStore((s) => s.settingsModalSection);
  return <>
    <main>{path === projectPath ? "Linear project" : "Original conversation"}</main>
    {section && <div role="dialog"><IssueSyncSources provider="linear" connected /></div>}
  </>;
}

async function reset() {
  window.history.replaceState(null, "", originalPath);
  await act(async () => {
    useInboxStore.setState({
      tabs: [{ id: "active", path: originalPath, title: "Original", createdAt: 1 }],
      activeTabId: "active",
      settingsModalSection: "integrations",
      clientState: { ui: { active_team_id: "team" } },
      issueSyncSources: {
        source: {
          _id: "source", workspace: "team:team", provider: "linear", status: "active",
          kind: "linear_team", name: "ASH", project_id: "linear-project", project_title: "ASH project",
        },
      },
    });
    root.render(<MemoryRouter initialEntries={[originalPath]}>
      <ConvexProvider client={client}><Screen /></ConvexProvider>
    </MemoryRouter>);
  });
}

try {
  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    await reset();
    const link = document.querySelector("a")!;
    assert.equal(link.textContent, "ASH project");
    assert.equal(link.getAttribute("href"), projectPath);
    let prevented = true;
    const stopBrowser = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", stopBrowser, { once: true });
    await act(async () => { link.dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: true, cancelable: true, button: 0, [modifier]: true,
    })); });
    assert.equal(prevented, false);
    assert.equal(useInboxStore.getState().settingsModalSection, "integrations");
    assert.equal(useInboxStore.getState().tabs[0].path, originalPath);
    assert.equal(document.querySelector("main")!.textContent, "Original conversation");
  }
  await reset();
  await act(async () => { document.querySelector("a")!.dispatchEvent(new dom.window.MouseEvent("click", {
    bubbles: true, cancelable: true, button: 0,
  })); });
  assert.equal(useInboxStore.getState().tabs[0].path, projectPath);
  assert.equal(window.location.pathname, projectPath);
  assert.equal(useInboxStore.getState().settingsModalSection, null);
  assert.equal(document.querySelector("[role=dialog]"), null);
  assert.equal(document.querySelector("main")!.textContent, "Linear project");
  console.log("project navigation scenarios passed");
} finally {
  await act(async () => root.unmount());
  await client.close();
  dom.window.close();
  restore();
}
