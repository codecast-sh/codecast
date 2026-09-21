import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { MemoryRouter } from "react-router";
import { DaemonStatusChip, SessionDaemonChip } from "../../DaemonStatusChip";
import { SyncStatusChip } from "../../SyncStatusChip";
import { CliOfflineBanner } from "../../CliOfflineBanner";
import { PendingDeliveryNote } from "../../PendingDeliveryNote";
import { StatusNoticeStack } from "../../StatusNoticeStack";
import { useInboxStore } from "../../../store/inboxStore";

export function healthRows(now = Date.now()) {
  return [
    { device_id: "mini", label: "macOS - Mac-mini", platform: "darwin", is_remote: false, online: false, last_seen: now - 8 * 60_000 },
    { device_id: "laptop", label: "macOS - MacBook", platform: "darwin", is_remote: false, online: true, last_seen: now - 1_000 },
    { device_id: "cloud", label: "Linux - grok-bot-vm-2307902", platform: "linux", is_remote: false, online: false, last_seen: now - 51 * 60_000 },
  ];
}

export function seedDaemonHealth() {
  useInboxStore.setState({
    currentUser: { _id: "health-viewer", daemon_last_seen: Date.now() - 3_600_000 } as any,
    machineRoster: healthRows(),
    sessions: {
      mini: { owner_device_id: "mini" },
      laptop: { owner_device_id: "laptop" },
      cloud: { owner_device_id: "cloud" },
      missing: { owner_device_id: "missing" },
      unassigned: {},
    } as any,
    liveLoading: {}, syncLogLag: {}, syncRole: "follower",
  });
}

export function daemonHealthClient() {
  return {
    connectionState: () => ({ isWebSocketConnected: true }),
    subscribeToConnectionState: () => () => {},
    mutation: async () => ({ commands: [
      { command_id: "mini", device_id: "mini" },
      { command_id: "laptop", device_id: "laptop" },
    ] }),
    query: async (_ref: unknown, args: { command_id: string }) => ({ executed_at: 1, result: JSON.stringify({
      port: 45123, token: args.command_id, device_id: args.command_id, tmux: true,
    }) }),
    watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, journal: () => undefined }),
  } as unknown as ConvexReactClient;
}

export function healthProbe(_input: RequestInfo | URL, init?: RequestInit) {
  const local = new Headers(init?.headers).get("Authorization") === "Bearer laptop";
  return Promise.resolve(Response.json(local ? { tmux: true, sessions: [] } : {}, { status: local ? 200 : 401 }));
}

export function DaemonHealthHarness({ client }: { client: ConvexReactClient }) {
  return <ConvexProvider client={client}><MemoryRouter>
    <div data-global><DaemonStatusChip /><SyncStatusChip /><CliOfflineBanner /><StatusNoticeStack /></div>
    {["mini", "laptop", "cloud", "missing", "unassigned"].map(id => <section key={id} data-session={id}>
      <SessionDaemonChip conversationId={id} />
      <PendingDeliveryNote state="stuck" restartInFlight={false} conversationId={id}>Session delivery controls</PendingDeliveryNote>
    </section>)}
  </MemoryRouter></ConvexProvider>;
}
