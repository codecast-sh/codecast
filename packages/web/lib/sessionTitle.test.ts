import { afterEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { resolveSessionTitle } from "./sessionTitle";

const original = useInboxStore.getState();
afterEach(() => useInboxStore.setState({ sessions: original.sessions, conversations: original.conversations }));

const setRows = (sessions: Record<string, { title?: string }>, conversations = {}) => {
  useInboxStore.setState({ sessions, conversations } as any);
};

describe("session title resolution", () => {
  test("preserves prefix order, skips empty titles, and prefers sessions", () => {
    setRows({ jx12345a: {}, jx12345b: { title: "Session" }, jx12345c: { title: "Later" } }, { jx12345d: { title: "Conversation" } });
    expect(resolveSessionTitle("jx12345")).toBe("Session");
    expect(resolveSessionTitle("jx12345d")).toBe("Conversation");
    expect(resolveSessionTitle("JX12345")).toBeNull();
    expect(resolveSessionTitle("missing")).toBeNull();
  });

  test("reuses matches and misses across revisited snapshots", () => {
    let scans = 0;
    const first = new Proxy({ jx12345a: { title: "First" } }, { ownKeys: (target) => { scans++; return Reflect.ownKeys(target); } });
    setRows(first);
    expect(resolveSessionTitle("jx12345")).toBe("First");
    expect(resolveSessionTitle("missing")).toBeNull();
    setRows({ jx12345a: { title: "Second" } });
    expect(resolveSessionTitle("jx12345")).toBe("Second");
    setRows(first);
    expect(resolveSessionTitle("jx12345")).toBe("First");
    expect(resolveSessionTitle("missing")).toBeNull();
    expect(scans).toBe(2);
  });

  test("reflects renamed, added, and removed rows on either collection", () => {
    setRows({ jx12345a: { title: "Before" } }, { jx12345b: { title: "Fallback" } });
    expect(resolveSessionTitle("jx12345")).toBe("Before");
    useInboxStore.setState({ sessions: { jx12345a: { title: "Renamed" } } } as any);
    expect(resolveSessionTitle("jx12345")).toBe("Renamed");
    useInboxStore.setState({ sessions: {} });
    expect(resolveSessionTitle("jx12345")).toBe("Fallback");
    useInboxStore.setState({ conversations: {} });
    expect(resolveSessionTitle("jx12345")).toBeNull();
    useInboxStore.setState({ conversations: { jx12345b: { title: "Added" } } } as any);
    expect(resolveSessionTitle("jx12345")).toBe("Added");
  });

  test("bounds cached queries per collection", () => {
    let scans = 0;
    const rows = new Proxy({}, { ownKeys: (target) => { scans++; return Reflect.ownKeys(target); } });
    setRows(rows);
    for (let i = 0; i < 512; i++) resolveSessionTitle(String(i));
    resolveSessionTitle("0");
    resolveSessionTitle("512");
    resolveSessionTitle("0");
    expect(scans).toBe(513);
    resolveSessionTitle("1");
    expect(scans).toBe(514);
  });
});
