import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { VaultInfo } from "@codecast/shared/contracts";

// A repo opened by path (/files?path=<repo>) registers with no `kind`, and only
// the scan says its root is a git checkout. Its code must show in the tree.

class QuietSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  send() {}
  close() {}
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  WebSocket: QuietSocket,
});
const { useVaultStore } = await import("../vaultStore");
const initial = useVaultStore.getState();
const originalFetch = globalThis.fetch;
const repo: VaultInfo = { id: "scratch", root: "/Users/ada/.cache/scratch/repo", name: "repo", added_at: 1 };
const endpoint = { port: 12345, token: "test", deviceId: "local", tmux: true };

function daemon(isRepo: boolean) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/vault/scan") {
      return Response.json({
        files: [
          { path: "src", mtime: 1, size: 0, dir: true },
          { path: "src/a.ts", mtime: 1, size: 10 },
        ],
        scanned_at: 1,
        repo: isRepo,
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  localStorage.clear();
  useVaultStore.setState({ ...initial, endpoint, vaults: [repo], activeVaultId: null, connection: "connected" }, true);
});
afterEach(() => {
  useVaultStore.setState(initial, true);
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  restoreGlobals();
  closeDomWindow(dom);
});

test("a git checkout registered by path opens showing its code files", async () => {
  daemon(true);
  await useVaultStore.getState().selectVault(repo.id);
  expect(useVaultStore.getState().isRepo).toBe(true);
  expect(useVaultStore.getState().showAllFiles).toBe(true);
});

test("a notes folder that is not a checkout keeps showing notes only", async () => {
  daemon(false);
  await useVaultStore.getState().selectVault(repo.id);
  expect(useVaultStore.getState().showAllFiles).toBe(false);
});

test("a person's explicit choice outranks the repo default", async () => {
  daemon(true);
  localStorage.setItem(`cast_vault_show_all:${repo.id}`, "0");
  await useVaultStore.getState().selectVault(repo.id);
  expect(useVaultStore.getState().isRepo).toBe(true);
  expect(useVaultStore.getState().showAllFiles).toBe(false);
});
