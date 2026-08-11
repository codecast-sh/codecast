import { test, expect, describe } from "bun:test";
import { messageRowKey, uniqueRowKeys } from "./messageRowKey";

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

describe("uniqueRowKeys", () => {
  // The bug this guards: the delivery-ack path stamped one pending row's
  // client_id onto TWO transcript messages (the harness's boot
  // <task-notification> turn, adopted positionally, plus the real echo, adopted
  // by content match). Two timeline rows sharing a React/virtualizer key accrete
  // ghost DOM copies painted over neighboring rows. Poisoned pairs exist in
  // synced data, so the renderer must de-collide whatever it is given.
  test("passes unique keys through untouched", () => {
    expect(uniqueRowKeys(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("suffixes every duplicate after the first occurrence", () => {
    const clientId = "acct-switch-cmd1-conv1";
    expect(uniqueRowKeys([clientId, "b", clientId])).toEqual([clientId, "b", `${clientId}~dup1`]);
  });

  test("suffixes are stable across renders and distinct per occurrence", () => {
    const input = ["k", "k", "k"];
    const first = uniqueRowKeys(input);
    expect(first).toEqual(["k", "k~dup1", "k~dup2"]);
    expect(uniqueRowKeys(input)).toEqual(first);
    expect(new Set(first).size).toBe(3);
  });
});
