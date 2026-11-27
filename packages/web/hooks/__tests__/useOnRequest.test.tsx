// The Files page opens its hidden tree on each search request and its side
// panel on each tag request; a request made before it mounted is not replayed.
import { expect, test } from "bun:test";
import { installModernDom } from "../../test-helpers/modernDom";

installModernDom("https://app.test/files");
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useVaultStore } = await import("../../store/vaultStore");
const { useOnRequest } = await import("../useOnRequest");

test("each openSearch after mount runs the page's handler once", async () => {
  useVaultStore.getState().openSearch("before mount");
  let opened = 0;
  function Page() {
    useOnRequest(useVaultStore((s) => s.searchPaneRequest), () => opened++);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Page />));
  expect(opened).toBe(0);
  // The Search tab is already the chosen one: the request still counts.
  await act(async () => useVaultStore.getState().openSearch());
  await act(async () => useVaultStore.getState().openSearch());
  expect(opened).toBe(2);
  expect(useVaultStore.getState().searchQuery).toBe("before mount");
  await act(async () => root.unmount());
});
