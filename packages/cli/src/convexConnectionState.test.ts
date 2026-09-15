import { describe, expect, test } from "bun:test";
import { bindConvexConnectionState, type ConvexSocketClient } from "./convexConnectionState.js";

function fakeClient(initial: boolean): {
  client: ConvexSocketClient;
  fire: (connected: boolean) => void;
} {
  let connected = initial;
  const listeners: Array<(cs: { isWebSocketConnected: boolean }) => void> = [];
  return {
    client: {
      connectionState: () => ({ isWebSocketConnected: connected }),
      subscribeToConnectionState: (cb) => {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    fire: (next) => {
      connected = next;
      for (const cb of listeners) cb({ isWebSocketConnected: next });
    },
  };
}

describe("bindConvexConnectionState", () => {
  test("records a socket that is already up when we subscribe", () => {
    const { client } = fakeClient(true);
    const writes: boolean[] = [];
    bindConvexConnectionState(client, { saveConnected: (c) => writes.push(c) });
    expect(writes).toEqual([true]);
  });

  test("records connecting now and connected when the socket later opens", () => {
    const { client, fire } = fakeClient(false);
    const writes: boolean[] = [];
    let restored = 0;
    bindConvexConnectionState(client, {
      saveConnected: (c) => writes.push(c),
      onRestored: () => { restored++; },
    });
    expect(writes).toEqual([false]);
    expect(restored).toBe(0);
    fire(true);
    expect(writes).toEqual([false, true]);
    expect(restored).toBe(1);
  });

  test("does not treat the initial seed as a restore, even when already connected", () => {
    const { client } = fakeClient(true);
    let restored = 0;
    bindConvexConnectionState(client, {
      saveConnected: () => {},
      onRestored: () => { restored++; },
    });
    expect(restored).toBe(0);
  });

  test("ignores inflight-only connectionState events that do not change the socket", () => {
    const { client, fire } = fakeClient(true);
    const writes: boolean[] = [];
    bindConvexConnectionState(client, { saveConnected: (c) => writes.push(c) });
    fire(true);
    fire(true);
    expect(writes).toEqual([true]);
  });

  test("a subscriber that never replays still sees the current state because we seed after subscribe", () => {
    const writes: boolean[] = [];
    const client: ConvexSocketClient = {
      connectionState: () => ({ isWebSocketConnected: true }),
      subscribeToConnectionState: () => () => {},
    };
    bindConvexConnectionState(client, { saveConnected: (c) => writes.push(c) });
    expect(writes).toEqual([true]);
  });
});
