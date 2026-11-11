import "../app/globals.css";
import "@platform/design/fonts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { CONVEX_URL } from "../lib/convexUrl";
import { useInboxStore } from "../store/inboxStore";
import { ConnectMachine, ConnectMachineDialog } from "../components/ConnectMachine";
import { Button } from "../components/ui/button";

const client = new ConvexReactClient(CONVEX_URL);
(client as any).mutation = async () => ({ token: "cx_setup_9f3b2a7e1c4d8f6a0b5e", expiresAt: Date.now() + 3_600_000 });
const dev = (id: string, label: string, online: boolean, platform = "darwin") => ({ device_id: id, label, hostname: label, platform, last_seen: Date.now() - 86_400_000, is_remote: false, local_project_roots: [], online });
useInboxStore.setState({ currentUser: { _id: "u1", name: "Ada" }, machineRoster: [dev("a", "MacBook-Pro-2", true), dev("b", "studio", false)], machineRosterLive: true } as any);
(window as any).bringBack = () => useInboxStore.setState({ machineRoster: [dev("a", "MacBook-Pro-2", true), dev("b", "studio", true)] } as any);

function App() {
  const [open, setOpen] = useState(new URLSearchParams(location.search).has("dialog"));
  return (
    <div className="mx-auto max-w-xl space-y-6 p-8 text-sol-text">
      <div className="rounded-xl border border-sol-border bg-sol-card p-5"><ConnectMachine location="harness" /></div>
      <Button onClick={() => setOpen(true)}>Reconnect studio</Button>
      <ConnectMachineDialog target={dev("b", "studio", false) as any} open={open} onOpenChange={setOpen} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<ConvexProvider client={client}><App /></ConvexProvider>);
