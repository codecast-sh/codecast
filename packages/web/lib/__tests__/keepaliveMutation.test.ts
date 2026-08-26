// The last word of a dying page.
//
// A mutation written to the Convex WebSocket inside `beforeunload` does not
// reliably leave before the socket is torn down. That was measured in a real
// browser, not assumed: finalizing a live voice burst through the ordinary
// client on a page reload left the row `live` on the server, while the same
// call with the page still alive landed instantly. Both unload guards in this
// codebase were built that way, so neither had ever done its job.
//
// `fetch` with `keepalive` is the channel that survives, and these tests pin
// the shape of the request — the URL, the token, the function path derived
// from a real API reference (so a rename breaks here rather than in an unload
// handler nobody is watching), and the fact that a page with no token sends
// nothing at all.

import { beforeEach, describe, expect, test } from "bun:test";

// Read from the module rather than restated here: another test file in this
// process stubs VITE_CONVEX_URL, which moves both the endpoint and the token's
// storage key. localAuth owns that layout and has its own contract test.
const { AUTH_JWT_STORAGE_KEY: KEY, CONVEX_URL: CONVEX } = await import("../localAuth");

let store: Record<string, string> = {};
const calls: Array<{ url: string; init: any }> = [];

// Installed per test, never at module load: bun runs every test file in one
// process, so a global claimed here would be traded away by whichever file
// ran next.
function installStubs(fetchImpl?: (url: string, init: any) => any) {
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  (globalThis as any).fetch =
    fetchImpl ??
    ((url: string, init: any) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true } as any);
    });
}

const { mutateOnUnload } = await import("../keepaliveMutation");
const { api } = await import("@codecast/convex/convex/_generated/api");

describe("mutateOnUnload", () => {
  beforeEach(() => {
    calls.length = 0;
    store = {};
    installStubs();
  });

  test("posts the mutation with keepalive and the stored token", () => {
    store[KEY] = "jwt-abc";
    mutateOnUnload((api as any).chat.cancelVoiceBurst, { message_id: "m1" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CONVEX}/api/mutation`);
    const init = calls[0].init;
    // keepalive is the whole point: without it the request dies with the page.
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt-abc");
    expect(JSON.parse(init.body)).toEqual({
      path: "chat:cancelVoiceBurst",
      args: { message_id: "m1" },
      format: "json",
    });
  });

  test("a signed-out page sends nothing", () => {
    mutateOnUnload((api as any).calls.leaveRoom, { room_key: "dm:a:b" });
    expect(calls).toHaveLength(0);
  });

  test("a thrown fetch never reaches the unloading page", () => {
    store[KEY] = "jwt-abc";
    installStubs(() => { throw new Error("network is gone"); });
    expect(() => mutateOnUnload((api as any).calls.leaveRoom, { room_key: "dm:a:b" })).not.toThrow();
  });
});
