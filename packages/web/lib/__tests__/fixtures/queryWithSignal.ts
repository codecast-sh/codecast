import { expect, test } from "bun:test";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { queryWithSignal } from "../../queryWithSignal";

const query = makeFunctionReference<"query", { probe: number }, string>("test:recovery");

test("aborting a stalled probe removes its real Convex subscription and the next probe succeeds", async () => {
  const active = new Set<number>();
  const removed: number[] = [];
  let version = 0;
  let respond = false;
  const endpoint = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        if (message.type !== "ModifyQuerySet") return;
        const updates = [];
        for (const change of message.modifications) {
          if (change.type === "Remove") {
            active.delete(change.queryId);
            removed.push(change.queryId);
          } else {
            active.add(change.queryId);
            if (respond) updates.push({
              type: "QueryUpdated", queryId: change.queryId, value: "recovered", logLines: [], journal: null,
            });
          }
        }
        ws.send(JSON.stringify({
          type: "Transition",
          startVersion: { querySet: version, ts: "AAAAAAAAAAA=", identity: 0 },
          endVersion: { querySet: message.newVersion, ts: "AAAAAAAAAAA=", identity: 0 },
          modifications: updates,
        }));
        version = message.newVersion;
      },
    },
  });
  const client = new ConvexReactClient(`http://127.0.0.1:${endpoint.port}`, { logger: false });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(5);
    expect(condition()).toBe(true);
  };
  try {
    for (let probe = 0; probe < 3; probe++) {
      const controller = new AbortController();
      const result = queryWithSignal(client, query, { probe }, controller.signal).catch((error) => error);
      await waitFor(() => active.size === 1);
      controller.abort();
      expect(await result).toBe(controller.signal.reason);
      await waitFor(() => active.size === 0);
    }
    expect(removed).toHaveLength(3);
    respond = true;
    expect(await queryWithSignal(client, query, { probe: 4 }, new AbortController().signal)).toBe("recovered");
    await waitFor(() => active.size === 0);
  } finally {
    await client.close();
    endpoint.stop(true);
  }
});

test("an already aborted probe never subscribes", async () => {
  const client = new ConvexReactClient("http://127.0.0.1:1", { logger: false });
  const controller = new AbortController();
  controller.abort();
  await expect(queryWithSignal(client, query, { probe: 1 }, controller.signal)).rejects.toBe(controller.signal.reason);
  await client.close();
});
