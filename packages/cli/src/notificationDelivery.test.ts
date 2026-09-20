import { describe, expect, test } from "bun:test";
import http from "http";
import { NotificationClaims, DESKTOP_ALERT_LEASE_MS, handleNotificationHttp } from "./notificationDelivery";

describe("machine notification claims", () => {
  test("desktop wins, duplicates collapse, and accounts and workspaces stay separate", () => {
    const broker = new NotificationClaims();
    broker.desktop("alice:team-a", "main", true);
    expect(broker.claim("alice:team-a", "chat:1", false, 60_000)).toBe("desktop");
    expect(broker.claim("alice:team-a", "chat:1", true, 60_000)).toBe("claimed");
    expect(broker.claim("alice:team-a", "chat:1", false, 60_000)).toBe("duplicate");
    expect(broker.claim("alice:team-a", "chat:2", true, 60_000)).toBe("claimed");
    expect(broker.claim("bob:team-a", "chat:1", false, 60_000)).toBe("claimed");
    expect(broker.claim("alice:team-b", "chat:1", false, 60_000)).toBe("claimed");
  });

  test("browser resumes when the last desktop window closes or its lease expires", () => {
    let now = 10;
    const broker = new NotificationClaims(() => now);
    broker.desktop("a", "main", true);
    broker.desktop("a", "chat", true);
    broker.desktop("a", "main", false);
    expect(broker.claim("a", "m", false, 60_000)).toBe("desktop");
    broker.desktop("a", "chat", false);
    expect(broker.claim("a", "m", false, 60_000)).toBe("claimed");
    broker.desktop("a", "main", true);
    now += DESKTOP_ALERT_LEASE_MS;
    expect(broker.claim("a", "next", false, 60_000)).toBe("claimed");
  });

  test("late desktop registration cannot replay a browser's event", () => {
    const broker = new NotificationClaims();
    expect(broker.claim("a", "m", false, 60_000)).toBe("claimed");
    broker.desktop("a", "main", true);
    expect(broker.claim("a", "m", true, 60_000)).toBe("duplicate");
  });

  test("room-local cues can sound in the browser while desktop runs", () => {
    const broker = new NotificationClaims();
    broker.desktop("a", "main", true);
    expect(broker.claim("a", "knock:room-b", false, 60_000, false)).toBe("claimed");
  });

  test("ring cycles expire while message claims remain", () => {
    let now = 1;
    const broker = new NotificationClaims(() => now);
    expect(broker.claim("a", "ring", false, 2_500)).toBe("claimed");
    expect(broker.claim("a", "message", false, 60_000)).toBe("claimed");
    now += 3_000;
    expect(broker.claim("a", "ring", false, 2_500)).toBe("claimed");
    expect(broker.claim("a", "message", false, 60_000)).toBe("duplicate");
  });

  test("authenticated HTTP claims arbitrate ten concurrent windows on this machine", async () => {
    const broker = new NotificationClaims();
    const server = http.createServer((req, res) => {
      if (!handleNotificationHttp(req, res, { token: "fixture", log() {} }, broker)) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const headers = { Authorization: "Bearer fixture", Origin: "https://codecast.sh" };
    const call = (route: string, params: Record<string, string>, extra = headers) =>
      fetch(`${base}/notifications/${route}?${new URLSearchParams({ scope: "viewer:team", ...params })}`, { method: "POST", headers: extra });
    try {
      const results = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
        const origin = i % 2 ? "https://local.codecast.sh" : "https://codecast.sh";
        return (await (await call("claim", { event: "chat:1", ttl: "60000" }, { ...headers, Origin: origin })).json()).result;
      }));
      expect(results.filter((v) => v === "claimed")).toHaveLength(1);
      expect(results.filter((v) => v === "duplicate")).toHaveLength(9);
      expect((await call("desktop", { client: "desktop", active: "1" })).status).toBe(200);
      expect((await (await call("claim", { event: "chat:2", ttl: "60000" })).json()).result).toBe("desktop");
      expect((await (await call("claim", { event: "chat:2", ttl: "60000", desktop: "1" })).json()).result).toBe("claimed");
      expect((await call("claim", { event: "chat:3", ttl: "60000" }, { ...headers, Authorization: "Bearer wrong" })).status).toBe(403);
      expect((await call("claim", { event: "chat:3", ttl: "60000" }, { ...headers, Origin: "https://evil.test" })).status).toBe(403);
      expect((await call("claim", { event: "chat:3", ttl: "Infinity" })).status).toBe(400);
      const preflight = await fetch(`${base}/notifications/claim`, { method: "OPTIONS", headers: { Origin: headers.Origin } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(headers.Origin);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
