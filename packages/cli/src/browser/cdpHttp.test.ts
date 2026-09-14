import { afterEach, expect, test } from "bun:test";
import { browserSocketUrl, CdpTimeout, listTargets } from "./cdp.js";
import { targetLiveness } from "./pinnedTab.js";

const servers: ReturnType<typeof Bun.serve>[] = [];

function serve(fetch: (request: Request) => Response | Promise<Response>): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server.port!;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("discovery timeouts name the request without exposing the bridge token", async () => {
  const port = serve(async () => {
    await delay(200);
    return Response.json([]);
  });
  const endpoint = { port, token: "private-bridge-token" };
  for (const [read, route] of [[browserSocketUrl, "/json/version"], [listTargets, "/json/list"]] as const) {
    const error = await read(endpoint, 20).catch(error => error);
    expect(error).toBeInstanceOf(CdpTimeout);
    expect(error.message).toContain(`CDP ${route} did not answer within 20ms`);
    expect(error.message).not.toContain(endpoint.token);
  }
});

test("the same named deadline covers a stalled JSON response body", async () => {
  const port = serve(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("[")); },
  }), { headers: { "content-type": "application/json" } }));
  for (let i = 0; i < 10; i++) {
    await expect(listTargets({ port, token: "secret" }, 30)).rejects.toThrow("CDP /json/list did not answer within 30ms");
  }
});

test("bridge tab discovery can exceed five seconds while direct endpoints keep their budget", async () => {
  const port = serve(async () => {
    await delay(5_200);
    return Response.json([{ id: "owned", type: "page", url: "https://owned.example/" }]);
  });
  const [bridge, direct] = await Promise.allSettled([listTargets({ port, token: "secret" }), listTargets(port)]);
  expect(bridge.status).toBe("fulfilled");
  expect(direct.status).toBe("rejected");
}, 15_000);

test("bridge liveness waits past two seconds and still treats unanswered checks as unknown", async () => {
  const port = serve(async () => {
    await delay(2_200);
    return Response.json([{ id: "owned", type: "page", url: "https://owned.example/" }]);
  });
  const [bridge, direct, timedOut] = await Promise.all([
    targetLiveness({ port, token: "secret" }, "owned"),
    targetLiveness(port, "owned"),
    targetLiveness({ port, token: "secret" }, "owned", 20),
  ]);
  expect({ bridge, direct, timedOut }).toEqual({ bridge: "alive", direct: "unknown", timedOut: "unknown" });
});
