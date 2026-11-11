import "./app/globals.css";
import "@platform/design/fonts";
import { createRoot } from "react-dom/client";
import { useInboxStore } from "./store/inboxStore";
import { MachineTailnet } from "./components/settings/MachineTailnet";

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
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
