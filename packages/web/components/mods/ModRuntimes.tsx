// Mounted once per window, in DashboardLayout: holds the hidden frames the
// enabled mods run in, keeps the running set equal to the enabled rows, and
// hands the host what it needs from React land (the router, and the mutation
// that ships a mod's logs to `cast mod logs`).

import { useEffect, useRef } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";
import { modHost, setModBridge } from "../../lib/mods/host";
import { useModRows } from "../../lib/mods/useMods";

const api = _api as any;

export function ModRuntimes() {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useModRows();
  const router = useRouter();
  const convex = useConvex();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    setModBridge({
      navigate: (path) => routerRef.current.push(path),
      log: (modId, entries) => {
        void convex.mutation(api.mods.webLog, { id: modId, entries }).catch(() => {});
      },
    });
    return () => setModBridge(null);
  }, [convex]);

  useEffect(() => {
    if (!ref.current) return;
    modHost.attach(ref.current);
    return () => modHost.detach();
  }, []);

  useEffect(() => {
    modHost.sync(rows);
  }, [rows]);

  return <div ref={ref} aria-hidden className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden opacity-0 [&_iframe]:h-0 [&_iframe]:w-0 [&_iframe]:border-0" />;
}
