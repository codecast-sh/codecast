import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTmuxDelivery, TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";

const dirs: string[] = [];
const stores: TmuxDeliveryJournal[] = [];
function file() { const dir = mkdtempSync(join(tmpdir(), "tmux-journal-")); dirs.push(dir); return join(dir, "journal.sqlite"); }
function open(path = file()) { const store = new TmuxDeliveryJournal(path); stores.push(store); return store; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const identity = { messageId: "message-a", conversationId: "conversation" };
const generation = JSON.stringify(["100", "/socket", "%1", "200", "300"]);
const query = async () => ({ stdout: "100|/socket|%1|200|300" });

test("a receipt survives a new connection and keeps an unresolved pane exclusive", () => {
  const path = file();
  const first = open(path);
  expect(first.begin(identity, generation, "continue").fresh).toBe(true);
  const restarted = open(path);
  expect(restarted.begin(identity, generation, "continue").fresh).toBe(false);
  expect(() => restarted.begin({ ...identity, messageId: "message-b" }, generation, "next")).toThrow("earlier message");
  expect(() => restarted.begin(identity, generation, "changed")).toThrow("identity changed");
  restarted.advance(identity.messageId, "verified");
  expect(first.begin({ ...identity, messageId: "message-b" }, generation, "continue").fresh).toBe(true);
  expect(first.begin(identity, generation, "continue").receipt.phase).toBe("verified");
});

test("server acknowledgment releases a receipt after the process died before verification", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  store.advance(identity.messageId, "submit");
  const next = { ...identity, messageId: "message-b" };
  await expect(prepareTmuxDelivery("target", next, query, async () => false, store)).rejects.toThrow("earlier message");
  await expect(prepareTmuxDelivery("target", next, query, async () => { throw new Error("offline"); }, store)).rejects.toThrow("reconciliation failed");
  await prepareTmuxDelivery("target", next, query, async id => id === identity.messageId, store);
  expect(store.begin(next, generation, "continue").fresh).toBe(true);
});

test("a replaced pane allows an unsubmitted write only after the old pane is definitively gone", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  const exec = async (args: string[]) => {
    if (args[3] === "%1") throw new Error("can't find pane: %1");
    return { stdout: "100|/socket|%2|201|301" };
  };
  const resolved = await prepareTmuxDelivery("new", identity, exec, async () => false, store);
  expect(resolved.prior).toBeNull();
  expect(store.begin(identity, resolved.generation, "continue").fresh).toBe(true);
});

test("an unreadable old pane and a submit with unknown outcome never authorize replay", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  const exec = async (args: string[]) => {
    if (args[3] === "%1") throw new Error("timeout");
    return { stdout: "100|/socket|%2|201|301" };
  };
  await expect(prepareTmuxDelivery("new", identity, exec, async () => false, store)).rejects.toThrow("timeout");
  store.advance(identity.messageId, "submit");
  const prepared = await prepareTmuxDelivery("new", identity, exec, async () => false, store);
  expect(() => store.begin(identity, prepared.generation, "continue")).toThrow("not been reconciled");
});

test("corrupt durable state fails closed", () => {
  const path = file();
  writeFileSync(path, "not a database");
  expect(() => new TmuxDeliveryJournal(path)).toThrow();
});

test("a confirmed exited agent permits retry only in a replacement terminal", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  store.advance(identity.messageId, "submit");
  store.recordTerminalExit(identity.messageId);
  expect(() => store.begin(identity, generation, "continue")).toThrow("exited terminal");
  const resolved = await prepareTmuxDelivery("new", identity, async () => ({ stdout: "100|/socket|%2|201|301" }), async () => false, store);
  expect(resolved.prior).toBeNull();
  expect(store.begin(identity, resolved.generation, "continue").fresh).toBe(true);
  expect(store.get(identity.messageId)?.terminalExited).toBe(0);
});
