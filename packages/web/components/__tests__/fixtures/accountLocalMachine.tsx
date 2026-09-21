import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { MemoryRouter } from "react-router";
import { AccountUsageChip } from "../../AccountUsageChip";
import { useLocalDeviceId } from "../../../hooks/useLocalDeviceId";
import { useInboxStore } from "../../../store/inboxStore";
import { settingsDataKey } from "../../../lib/settingsData";

export const localDevice = {
  device_id: "local-mac",
  label: "macOS - Alexanders-MacBook-Pro-4",
  is_remote: false,
  online: true,
  auto_switch: false,
  active_email: "local@example.com",
  profiles: [
    { name: "local", email: "local@example.com", login_expired_at: 1 },
    { name: "backup", email: "backup@example.com" },
  ],
};
export const otherDevice = { ...localDevice, device_id: "other-mac", label: "Other Mac", active_email: "other@example.com", profiles: [{ name: "other", email: "other@example.com", login_expired_at: 1 }] };

export function seedAccounts(devices = [otherDevice, localDevice], viewer: string | null = "viewer-one") {
  const key = settingsDataKey("accountProfiles", viewer);
  useInboxStore.setState({
    currentUser: viewer ? { _id: viewer } as any : null,
    syncRole: "follower",
    settingsData: key ? { [key]: { _id: key, value: { devices } } } : {},
  });
}

export function createAccountClient() {
  const mutations: Array<{ name: string; args: any }> = [];
  const listeners = new Set<() => void>();
  let connected = true;
  const client = {
    url: "https://account-fixture.invalid",
    connectionState: () => ({ isWebSocketConnected: connected }),
    subscribeToConnectionState: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    mutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      mutations.push({ name, args });
      if (name === "users:requestTerminalEndpoints") return { commands: [
        { command_id: "other-command", device_id: otherDevice.device_id },
        { command_id: "local-command", device_id: localDevice.device_id },
      ] };
      if (name === "accountSwitch:requestAccountSwitch") return { command_ids: ["switch-command"] };
      return {};
    },
    query: async (_ref: any, args: any) => ({ executed_at: 1, result: JSON.stringify({
      port: 45123,
      token: args.command_id === "local-command" ? "local-fixture" : "other-fixture",
      device_id: args.command_id === "local-command" ? localDevice.device_id : otherDevice.device_id,
      tmux: true,
    }) }),
    watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, journal: () => undefined }),
  };
  return {
    client: client as unknown as ConvexReactClient,
    mutations,
    connect(value: boolean) { connected = value; for (const listener of listeners) listener(); },
  };
}

function LocalIdentity() {
  const id = useLocalDeviceId(true);
  return <output data-local-device>{id ?? "unresolved"}</output>;
}

export function AccountHarness({ client, identityOnly = false }: { client: ConvexReactClient; identityOnly?: boolean }) {
  return <ConvexProvider client={client}><MemoryRouter>{identityOnly ? <LocalIdentity /> : <AccountUsageChip />}</MemoryRouter></ConvexProvider>;
}
