import { describe, expect, test } from "bun:test";
import { buildFleetDiff } from "./fleetDiff";

const mcp = (extra: Record<string, unknown>) => ({ kind: "mcp", name: "sentry", scope: "user", enabled: true, ...extra });

describe("MCP sign-in per machine", () => {
  test("each CLI that reaches a remote server can sign in to it, and a project server runs in its project", () => {
    const { rows } = buildFleetDiff([
      {
        deviceId: "host",
        inventory: {
          items: [
            mcp({ client: "claude", meta: { transport: "http", url: "https://mcp.sentry.dev/mcp", auth: "needed" } }),
            mcp({ client: "codex", scope: "project", source: "/w/app/.codex/config.toml", meta: { transport: "http", url: "https://mcp.sentry.dev/mcp" } }),
          ],
        },
      },
      { deviceId: "laptop", inventory: { items: [mcp({ meta: { transport: "stdio", command: "npx sentry" } })] } },
    ] as any);
    const cells = Object.fromEntries(rows[0].cells.map((c) => [c.deviceId, c]));
    expect(cells.host.signIn).toEqual([
      { client: "claude", needed: true },
      { client: "codex", cwd: "/w/app", needed: false },
    ]);
    expect(cells.laptop.signIn).toBeUndefined();
  });
});
