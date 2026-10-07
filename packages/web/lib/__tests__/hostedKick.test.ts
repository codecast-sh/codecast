import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { withHostedKick } from "../hostedKick";

const HOSTED = "a".repeat(32);
const LOCAL = "b".repeat(32);
const NEW = "c".repeat(32);

function seed() {
  const s = useInboxStore.getState();
  useInboxStore.setState({
    sessions: { ...s.sessions, [HOSTED]: { _id: HOSTED, agent_type: "codecast" } as any, [LOCAL]: { _id: LOCAL, agent_type: "claude_code" } as any },
  } as any);
}

async function run(action: string, args: unknown, landed: unknown = null): Promise<string[]> {
  const kicked: string[] = [];
  const dispatch = withHostedKick(async () => landed, async (id) => kicked.push(id));
  expect(await dispatch(action, args)).toBe(landed);
  await Promise.resolve();
  return kicked;
}

describe("hosted kick", () => {
  afterEach(() => {
    const { [HOSTED]: _h, [LOCAL]: _l, ...rest } = useInboxStore.getState().sessions;
    useInboxStore.setState({ sessions: rest } as any);
  });

  it("kicks a hosted conversation after a send, a release, a retry, and a hosted create lands", async () => {
    seed();
    expect(await run("sendMessage", [HOSTED, "hi", undefined, "client-1"])).toEqual([HOSTED]);
    expect(await run("releaseQueued", [HOSTED])).toEqual([HOSTED]);
    expect(await run("retryPendingMessage", [HOSTED, { clientId: "client-1" }])).toEqual([HOSTED]);
    expect(await run("createSession", [{ agent_type: "codecast", session_id: "stub" }], NEW)).toEqual([NEW]);
  });

  it("leaves daemon sessions, other actions, stub ids and failed writes alone", async () => {
    seed();
    expect(await run("sendMessage", [LOCAL, "hi"])).toEqual([]);
    expect(await run("createSession", [{ agent_type: "claude_code" }], NEW)).toEqual([]);
    expect(await run("pinSession", [HOSTED])).toEqual([]);
    expect(await run("sendMessage", ["stub-123", "hi"])).toEqual([]);
    const kicked: string[] = [];
    const failing = withHostedKick(async () => { throw new Error("refused"); }, async (id) => kicked.push(id));
    await expect(failing("sendMessage", [HOSTED, "hi"])).rejects.toThrow("refused");
    expect(kicked).toEqual([]);
  });
});
