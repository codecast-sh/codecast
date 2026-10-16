// Mounted once per window, in DashboardLayout: holds the hidden frames the
// enabled mods run in, keeps the running set equal to the enabled rows, and
// hands the host what it needs from React land (the router, and the mutation
// that ships a mod's logs to `cast mod logs`).

import { useRef } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";
import { modHost, setModBridge } from "../../lib/mods/host";
import { useModRows } from "../../lib/mods/useMods";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";

const api = _api as any;
const NONE: readonly string[] = [];

export function ModRuntimes() {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useModRows();
  const installed = useInboxStore((s) => s.clientState.ui?.mods_installed) ?? NONE;
  const router = useRouter();
  const convex = useConvex();
  const routerRef = useRef(router);
  routerRef.current = router;

  useWatchEffect(() => {
    setModBridge({
      navigate: (path) => routerRef.current.push(path),
      log: (modId, entries) => {
        void convex.mutation(api.modLogs.webLog, { id: modId, entries }).catch(() => {});
      },
      callLocal: async (modId, method, args) => {
        const id = await convex.mutation(api.modCalls.webCall, { mod_id: modId, method, args });
        // The daemon that runs the half claims the call within seconds and writes the answer back.
        return await new Promise((resolve, reject) => {
          const watch = convex.watchQuery(api.modCalls.webGetCall, { id });
          const timer = setTimeout(() => { stop(); reject(new Error("no machine running this mod's local half answered within 2 minutes (cast mod local shows where it runs)")); }, 120_000);
          const stop = watch.onUpdate(() => {
            const call = watch.localQueryResult() as any;
            if (!call || call.status === "pending" || call.status === "running") return;
            clearTimeout(timer);
            stop();
            if (call.status === "failed") reject(new Error(call.error ?? "the local half failed"));
            else resolve(call.result);
          });
        });
      },
      callServer: async (modId, method, args) => {
        const team = useInboxStore.getState().clientState.ui?.active_team_id;
        const res = await convex.action(api.modServer.call, { mod_id: modId, method, args_json: JSON.stringify(args), ...(team ? { team_id: team } : {}) });
        // A reader answers its data and throws when it fails; a fetch answers like fetch does, throwing only when nothing came back.
        if (method === "connector.read") {
          if (!res.ok) throw new Error(res.error ?? `the reader answered ${res.status}`);
          return res.json ?? res.text ?? null;
        }
        if (res.status === undefined) throw new Error(res.error ?? "the request failed");
        return { ok: res.ok, status: res.status, headers: res.headers ?? {}, text: res.text ?? "", json: res.json };
      },
    });
    return () => setModBridge(null);
  }, [convex]);

  useMountEffect(() => {
    if (!ref.current) return;
    modHost.attach(ref.current);
    return () => modHost.detach();
  });

  useWatchEffect(() => {
    modHost.sync(rows, installed);
  }, [rows, installed]);

  return <div ref={ref} aria-hidden className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden opacity-0 [&_iframe]:h-0 [&_iframe]:w-0 [&_iframe]:border-0" />;
}
