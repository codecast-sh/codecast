import { test, expect, describe } from "bun:test";
import { messageRowKey } from "./messageRowKey";

describe("messageRowKey", () => {
  // The bug this guards: a user send in a NEW session renders first as an
  // optimistic row, then the server echo replaces it. If the row key changes
  // between the two, the virtualizer unmounts the optimistic row and mounts a
  // fresh server row — a one-frame blank that, when it's the only message,
  // reads as the message vanishing before it "syncs in".
  test("the optimistic copy and its server echo share one key", () => {
    const clientId = "optimistic_1700000000000_abc123";
    const optimistic = { _id: clientId, _clientId: clientId };
    const serverEcho = { _id: "k57e81f05qkyj0t77k1p182m9s890xjk", client_id: clientId };
    expect(messageRowKey(optimistic)).toBe(clientId);
    expect(messageRowKey(serverEcho)).toBe(clientId);
    expect(messageRowKey(optimistic)).toBe(messageRowKey(serverEcho));
  });

  test("a plain server message (no client id) keys by its _id", () => {
    expect(messageRowKey({ _id: "k57abc" })).toBe("k57abc");
  });

  test("client_id wins over a differing _id (the synced row)", () => {
    expect(messageRowKey({ _id: "convex_id", client_id: "c1" })).toBe("c1");
  });

  test("_clientId wins over _id when no server client_id yet (the optimistic row)", () => {
    expect(messageRowKey({ _id: "c1", _clientId: "c1" })).toBe("c1");
  });
});
