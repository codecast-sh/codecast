import { afterEach, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

const initial = useInboxStore.getState();
const id = "a".repeat(32);
const message = (i: number) => ({ _id: `redrive-${i}`, _clientId: `redrive-${i}`, content: `message ${i}`, role: "user", timestamp: 1, _isOptimistic: true });
afterEach(() => useInboxStore.setState(initial, true));

it("lets other tasks run between recovery sends and preserves their order", async () => {
  const sent: string[] = [];
  useInboxStore.setState({
    currentUser: { _id: "user-a" },
    pendingMessages: { [id]: Array.from({ length: 20 }, (_, i) => message(i)) },
    sendMessage: (_id: string, content: string) => { sent.push(content); },
  } as any);
  const recovery = useInboxStore.getState().redrivePendingMessages();
  expect(sent).toHaveLength(0);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThan(20);
  await recovery;
  expect(sent).toEqual(Array.from({ length: 20 }, (_, i) => `message ${i}`));
});

it("reads current pending rows after yielding and skips rows already reconciled", async () => {
  const sent: string[] = [];
  useInboxStore.setState({
    pendingMessages: { [id]: [message(0), message(1)] },
    sendMessage: (_id: string, content: string) => { sent.push(content); },
  } as any);
  const recovery = useInboxStore.getState().redrivePendingMessages();
  useInboxStore.setState({ pendingMessages: { [id]: [{ ...message(1), _dispatchContent: "exact dispatch bytes" }] } } as any);
  await recovery;
  expect(sent).toEqual(["exact dispatch bytes"]);
});

it("stops recovery if the account changes while it yields", async () => {
  const sent: string[] = [];
  useInboxStore.setState({
    currentUser: { _id: "user-a" }, pendingMessages: { [id]: [message(0)] },
    sendMessage: (_id: string, content: string) => { sent.push(content); },
  } as any);
  const recovery = useInboxStore.getState().redrivePendingMessages();
  useInboxStore.setState({ currentUser: { _id: "user-b" } } as any);
  await recovery;
  expect(sent).toEqual([]);
});
