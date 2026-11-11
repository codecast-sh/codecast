import "./app/globals.css";
import "@platform/design/fonts";
import { createRoot } from "react-dom/client";
import { useInboxStore } from "./store/inboxStore";
import { MachineTailnet } from "./components/settings/MachineTailnet";
import { PeerTransferStrip } from "./components/conversation/sessionChrome";

const now = Date.now();
const tn = (name: string, ip: string, extra: Record<string, unknown> = {}) => ({ ip, name: `${name}.tail1234.ts.net.`, tailnet: "tail1234.ts.net", ts_user_id: "42", bindable: true, ...extra });
const base = { platform: "darwin", online: true, last_seen: now, cli_version: "1.1.221" };
const self = { ...base, device_id: "self", label: "MacBook-Pro-2", tailnet: tn("mbp-2", "100.101.1.2") };
const rows = [
  self,
  { ...base, device_id: "a", label: "MacBook-Pro-182", tailnet: tn("mbp-182", "100.101.1.3"), peer_links: [{ to_device_id: "self", last_direct_ok_at: now - 60_000 }] },
  { ...base, device_id: "b", label: "Mac mini", tailnet: tn("mini", "100.101.1.4") },
  { ...base, device_id: "c", label: "Work laptop", tailnet: tn("work", "100.101.1.5", { ts_user_id: "77" }) },
  { ...base, device_id: "d", label: "Linux box", platform: "linux", tailnet: tn("box", "100.101.1.6", { bindable: false }) },
  { ...base, device_id: "e", label: "Old laptop", cli_version: "1.1.200" },
  { ...base, device_id: "f", label: "Studio", cli_version: "1.1.230" },
  { ...base, device_id: "g", label: "MacBook Air", tailnet: tn("air", "100.101.1.7"), peer_links: [{ to_device_id: "self", last_direct_failure: { at: now - 30_000, reason: "connect_timeout: no answer in 5s" } }] },
  { ...base, device_id: "h", label: "iMac", tailnet: tn("imac", "100.101.1.8"), direct_links_off: true },
  { ...base, device_id: "i", label: "Travel laptop", online: false, tailnet: tn("travel", "100.101.1.9") },
];
const MB = 1024 * 1024;
const pts: Record<string, any> = {
  c1: { phase: "asking", started_at: now, updated_at: now },
  c2: { phase: "receiving", from: "MacBook-Pro-182", mode: "direct", bytes: 412 * MB, total: 1240 * MB, started_at: now, updated_at: now },
  c3: { phase: "receiving", from: "Mac mini", mode: "relay", total: 180 * MB, started_at: now, updated_at: now },
  c4: { phase: "unpacking", from: "MacBook-Pro-182", mode: "direct", total: 1240 * MB, started_at: now, updated_at: now },
  c5: { phase: "receiving", from: "MacBook-Pro-182", mode: "direct", bytes: 10 * MB, total: 1240 * MB, started_at: now, updated_at: now, cancel_requested_at: now },
  c6: { phase: "failed", reason: "MacBook-Pro-182: direct link failed (connect_timeout); relay: /Users/ashot/src/family is over 300 MB, too large to carry", started_at: now, updated_at: now },
  c7: { phase: "receiving", from: "MacBook-Pro-182", mode: "direct", bytes: 10 * MB, total: 1240 * MB, started_at: now - 600_000, updated_at: now - 600_000 },
};
const conversations = Object.fromEntries(Object.entries(pts).map(([id, pt]) => [id, { _id: id, peer_transfer: pt }]));
useInboxStore.setState({ conversations: { ...(useInboxStore.getState().conversations as any), ...conversations } as any });
useInboxStore.setState({ currentUser: { _id: "u" } as any, localDevice: { viewer: "u", deviceId: "self" } as any, machineRoster: rows as any });

function App() {
  const roster = useInboxStore((s) => s.machineRoster) as any[];
  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="rounded-lg border border-sol-border bg-sol-card divide-y divide-sol-border">
        {roster.map((d) => (
          <div key={d.device_id} className="px-5 py-4">
            <div className="text-sm font-medium text-sol-text">{d.label}{d.device_id === "self" ? " · this machine" : ""}</div>
            <MachineTailnet device={d} />
          </div>
        ))}
      </div>
      <div className="mt-8 rounded-lg border border-sol-border bg-sol-card overflow-hidden divide-y divide-sol-border">
        {Object.keys(pts).map((id) => <PeerTransferStrip key={id} conversationId={id} onRetry={() => {}} />)}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
