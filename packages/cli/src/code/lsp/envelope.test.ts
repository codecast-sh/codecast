import { describe, expect, test } from "bun:test";
import { INSPECT_MAX_CHARS, peekEnvelope, readEnvelope } from "./envelope.js";

const pad = "z".repeat(64);

describe("peekEnvelope", () => {
  test("reads id and method from the head, as vscode-jsonrpc and lsp-client write them", () => {
    const text = `{"jsonrpc":"2.0","id":12,"method":"textDocument/completion","params":{"x":"${pad}"}}`;
    const env = peekEnvelope(text);
    expect(env).toMatchObject({ id: 12, method: "textDocument/completion" });
    expect(JSON.parse(env.withId("codecast-3"))).toEqual({ ...JSON.parse(text), id: "codecast-3" });
  });

  test("reads a response id written last, as gopls does", () => {
    const text = `{"jsonrpc":"2.0","result":{"items":[{"id":5,"label":"${pad}"}]},"id":"codecast-7"}`;
    const env = peekEnvelope(text);
    expect(env.id).toBe("codecast-7");
    expect(env.method).toBeUndefined();
    expect(JSON.parse(env.withId(12))).toEqual({ ...JSON.parse(text), id: 12 });
  });

  test("a notification has no id, even when its params end in one", () => {
    const env = peekEnvelope(`{"jsonrpc":"2.0","method":"x","params":{"items":[{"id":5}]}}`);
    expect(env).toMatchObject({ method: "x" });
    expect(env.id).toBeUndefined();
    expect(env.withId(1)).toBe(env.text);
  });

  test("a request with its method second and id last is a request", () => {
    const env = peekEnvelope(`{"jsonrpc":"2.0","method":"workspace/applyEdit","params":{},"id":3}`);
    expect(env).toMatchObject({ id: 3, method: "workspace/applyEdit" });
  });

  test("reads a didOpen's uri without the text, escapes and all", () => {
    const env = peekEnvelope(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///a \\"b\\".ts","languageId":"ts","version":1,"text":"${pad}"}}}`);
    expect(env.uri).toBe('file:///a "b".ts');
  });

  test("an escaped string id survives the round trip", () => {
    const env = peekEnvelope(`{"jsonrpc":"2.0","id":"a\\"b","result":null}`);
    expect(env.id).toBe('a"b');
    expect(JSON.parse(env.withId(4)).id).toBe(4);
  });
});

describe("readEnvelope", () => {
  test("drops a message that is not an object", () => {
    expect(readEnvelope('{"jsonrpc":"2.0","id":1,"result":2}')).toMatchObject({ id: 1 });
    expect(readEnvelope("[1]")).toBeNull();
    expect(readEnvelope('"str"')).toBeNull();
    expect(readEnvelope("{nope")).toBeNull();
  });

  test("never parses a message its ends can read, however big", () => {
    // The body is not JSON: a parse would reject it, so reading the id proves none ran.
    const text = `{"jsonrpc":"2.0","id":9,"result":{"items":[${"{".repeat(INSPECT_MAX_CHARS * 4)}]}}`;
    const env = readEnvelope(text)!;
    expect(env.id).toBe(9);
    expect(env.withId("codecast-1").startsWith('{"jsonrpc":"2.0","id":"codecast-1","result"')).toBe(true);
    expect(env.full()).toBeNull();
  });

  test("parses a small message whose id sits where the ends cannot see it", () => {
    const text = '{"method":"workspace/configuration","id":4,"params":{"items":[]},"jsonrpc":"2.0"}';
    const env = readEnvelope(text)!;
    expect(env).toMatchObject({ id: 4, method: "workspace/configuration" });
    expect(JSON.parse(env.withId("codecast-2"))).toEqual({ ...JSON.parse(text), id: "codecast-2" });
  });

  test("a big message in an unusual key order is relayed as having no id", () => {
    const env = readEnvelope(`{"result":{"s":"${"y".repeat(INSPECT_MAX_CHARS)}"},"id":3,"jsonrpc":"2.0"}`)!;
    expect(env.id).toBeUndefined();
  });
});
