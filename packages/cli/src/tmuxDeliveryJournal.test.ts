import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingMessageFinished, prepareTmuxDelivery, TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";

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
    if (args[0] === "list-panes") return { stdout: "%2\n" };
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
    if (args[0] === "list-panes") return { stdout: "%1\n%2\n" };
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

test("a submit into a pane that is definitively gone replays once the echo window passes with no acknowledgment", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  store.advance(identity.messageId, "submit");
  // The tmux server restarted on the same socket: every pane of the old one is gone.
  const restarted = async () => ({ stdout: "101|/socket|%2|201|301" });
  const early = await prepareTmuxDelivery("new", identity, restarted, async () => false, store);
  expect(() => store.begin(identity, early.generation, "continue")).toThrow("not been reconciled");
  const settled = await prepareTmuxDelivery("new", identity, restarted, async () => false, store, { settleMs: 0 });
  expect(settled.prior).toBeNull();
  expect(store.begin(identity, settled.generation, "continue").fresh).toBe(true);
});

test("a message that can never be delivered again stops guarding its pane", async () => {
  const lookup = (answer: string | Error) => ({ getPendingMessageStatus: async () => { if (answer instanceof Error) throw answer; return answer; } });
  expect(await pendingMessageFinished(lookup("delivered"), "m")).toBe(true);
  expect(await pendingMessageFinished(lookup("cancelled"), "m")).toBe(true);
  expect(await pendingMessageFinished(lookup(new Error("Uncaught Error: Message not found")), "m")).toBe(true);
  expect(await pendingMessageFinished(lookup("pending"), "m")).toBe(false);
  expect(await pendingMessageFinished(lookup("undeliverable"), "m")).toBe(false);
  await expect(pendingMessageFinished(lookup(new Error("offline")), "m")).rejects.toThrow("offline");
});

test("a settled paste whose message stopped retrying frees the pane for the next message", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  const next = { ...identity, messageId: "message-b" };
  await expect(prepareTmuxDelivery("target", next, query, async () => false, store)).rejects.toThrow("earlier message");
  await prepareTmuxDelivery("target", next, query, async () => false, store, { settleMs: 0 });
  expect(store.get(identity.messageId)).toBeNull();
  expect(store.begin(next, generation, "next").fresh).toBe(true);
});

test("a settled submit keeps the pane even when its message is unacknowledged", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  store.advance(identity.messageId, "submit");
  const next = { ...identity, messageId: "message-b" };
  await expect(prepareTmuxDelivery("target", next, query, async () => false, store, { settleMs: 0 })).rejects.toThrow("earlier message");
});

test("a verification the server never acknowledged is reported once the receipt settles", async () => {
  const store = open();
  store.begin(identity, generation, "continue");
  store.advance(identity.messageId, "verified");
  expect((await prepareTmuxDelivery("target", identity, query, async () => false, store)).unacknowledged).toBe(false);
  expect((await prepareTmuxDelivery("target", identity, query, async () => true, store, { settleMs: 0 })).unacknowledged).toBe(false);
  const settled = await prepareTmuxDelivery("target", identity, query, async () => false, store, { settleMs: 0 });
  expect(settled.unacknowledged).toBe(true);
  expect(settled.prior?.phase).toBe("verified");
});
