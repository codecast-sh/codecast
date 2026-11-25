// The person's vimrc for the settings page: the daemon's response (each source
// with its text, the overlay, what was not followed) and the report of the
// config vim runs with. Both come from vimFeature, the same read and the same
// applied config the editors use, so the page shows exactly what took effect.
// The vim engine loads with the page; nothing of it joins the main bundle.

import { useCallback, useRef, useState } from "react";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";
import type { VimConfigReport } from "../../../lib/code/vim/types";
import type { VaultEndpoint } from "../../../lib/vault/client";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useMountEffect } from "../../../hooks/useMountEffect";
import type { EndpointState } from "./useEditorEndpoint";

type VimFeatureModule = typeof import("../../../lib/code/vimFeature");

export interface VimConfigState {
  response: CodeVimrcResponse | null;
  report: VimConfigReport | null;
  error: string | null;
  reloading: boolean;
  reload: () => void;
}

const loadVimFeature = (): Promise<VimFeatureModule> =>
  import("../../../lib/code/vimFeature").then((m) => {
    m.registerVimFeature();
    return m;
  });

export function useVimConfig(endpoint: EndpointState): VimConfigState {
  const ep = endpoint.status === "ready" ? endpoint.ep : null;
  const epRef = useRef<VaultEndpoint | null>(ep);
  epRef.current = ep;
  const [response, setResponse] = useState<CodeVimrcResponse | null>(null);
  const [report, setReport] = useState<VimConfigReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // Whatever vim already holds paints at once: the config cached from the
  // last read, applied before the daemon answers. A newer config (the
  // daemon's answer, a reload, an overlay save) replaces it as it lands.
  useMountEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    void loadVimFeature().then((vf) => {
      if (!live) return;
      const show = (next: VimConfigReport) => {
        setReport(next);
        const r = vf.currentVimrcResponse();
        if (r) setResponse(r);
      };
      off = vf.onVimReport(show);
      void vf.vimConfigReport(epRef.current).then((rep) => live && show(rep), () => {});
    });
    return () => {
      live = false;
      off?.();
    };
  });

  // The daemon's own answer, once it can be reached.
  useWatchEffect(() => {
    if (!ep) return;
    let live = true;
    void loadVimFeature()
      .then(async (vf) => {
        const r = await vf.readVimrcResponse(ep);
        if (!live) return;
        setResponse(r);
        setError(null);
        const rep = await vf.vimConfigReport(ep);
        if (live) setReport(rep);
      })
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [ep]);

  const reload = useCallback(() => {
    const at = epRef.current;
    if (!at) return;
    setReloading(true);
    void loadVimFeature()
      .then(async (vf) => {
        const rep = (await vf.reloadVimConfig(at)) ?? (await vf.vimConfigReport(at));
        setReport(rep);
        setResponse(await vf.readVimrcResponse(at));
        setError(null);
      })
      .catch(fail)
      .finally(() => setReloading(false));
  }, []);

  return { response, report, error, reloading, reload };
}
