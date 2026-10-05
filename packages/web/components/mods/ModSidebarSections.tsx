// The sidebar sections mods declare (manifest `sidebar`): each one a rail
// heading and whatever the mod draws under it, sized for the narrow column.

import { useMemo } from "react";
import type { ModSurface } from "@codecast/shared/contracts/mods";
import { RailHeading } from "../sidebar/navPrimitives";
import { ModSurfaceView } from "./ModSurface";
import { modHost, type ModRuntime } from "../../lib/mods/host";
import { useModHostVersion } from "../../lib/mods/useMods";

function Section({ runtime, id, title }: { runtime: ModRuntime; id: string; title: string }) {
  const surface = useMemo<ModSurface>(() => ({ kind: "sidebar", id }), [id]);
  return (
    <div data-mod-sidebar={`${runtime.row.name}:${id}`}>
      <RailHeading label={title} isNarrow={false} />
      <div className="px-2 text-[12.5px]">
        <ModSurfaceView runtime={runtime} surface={surface} instance="sidebar" />
      </div>
    </div>
  );
}

export function ModSidebarSections({ isNarrow }: { isNarrow: boolean }) {
  useModHostVersion();
  if (isNarrow) return null;
  const sections = modHost.all().flatMap((rt) => (rt.row.manifest.sidebar ?? []).map((s) => ({ rt, ...s })));
  if (!sections.length) return null;
  return <>{sections.map((s) => <Section key={`${s.rt.row.name}:${s.id}`} runtime={s.rt} id={s.id} title={s.title} />)}</>;
}
