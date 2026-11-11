// Product views for live artifacts, one per doc type. A product registers its
// view here (a one-line lazy import) and receives LiveViewProps.
import { lazy, type ComponentType, type ReactNode } from "react";
import type { ArtifactElement, ArtifactPosition, ArtifactType } from "@codecast/shared/artifacts";
import type { LiveHandle } from "./useLiveArtifact";

export type ScreenPoint = { x: number; y: number; w?: number; h?: number };

export type LiveViewProps = {
  doc: { _id: string; title: string; doc_type: ArtifactType; project_path?: string; git_root?: string };
  live: LiveHandle;
  selection: string[];
  setSelection: (keys: string[]) => void;
  /** "view": a version is open or the viewer cannot edit; render, never write. */
  mode: "view" | "edit";
  /** Set while a version is open: render these instead of the live elements. */
  snapshot?: ArtifactElement[];
  /**
   * Tell the shell where a position is on screen, in pixels relative to the
   * view's container (null when off screen). The shell places every cursor,
   * name tag and comment pin with it. Call again when the mapping changes
   * (pan, zoom, scroll).
   */
  toScreen: (map: (pos: ArtifactPosition) => ScreenPoint | null) => void;
  /** Product controls in the top bar, before History. */
  setToolbar: (node: ReactNode) => void;
  /** A right-side drawer the shell lays out beside the view; null closes it. */
  setPanel: (node: ReactNode | null) => void;
};

/** The foundation's proof views. `?view=minimal` on an artifact's page forces them (the end-to-end check runs on these). */
export const MINIMAL_VIEWS: Record<ArtifactType, ComponentType<LiveViewProps>> = {
  board: lazy(() => import("./minimal/MinimalBoardView")),
  sheet: lazy(() => import("./minimal/MinimalSheetView")),
  dashboard: lazy(() => import("./minimal/MinimalDashboardView")),
};

/** What a product's shared (public link) view receives: the saved layer, read only. */
export type LiveSharedViewProps = {
  doc: { _id: string; title: string; doc_type: ArtifactType; updated_at?: number; user?: { name?: string; image?: string } | null };
  elements: ArtifactElement[];
  shareToken: string;
};

/** Shared-link views, one per product that has one; the rest show their text form. */
export const LIVE_SHARED_VIEWS: Partial<Record<ArtifactType, ComponentType<LiveSharedViewProps>>> = {
  board: lazy(() => import("../boards/SharedBoard")),
  sheet: lazy(() => import("../sheets/SharedSheet")),
  dashboard: lazy(() => import("../data/SharedDashboard")),
};

/**
 * Whether a product draws its whole shared page, heading included, at full
 * width (a dashboard's story headline). The others sit under the share page's
 * own heading in a wide column.
 */
export function hasLiveSharedView(type: string): boolean {
  return type === "dashboard";
}

export const LIVE_VIEWS: Record<ArtifactType, ComponentType<LiveViewProps>> = {
  board: lazy(() => import("../boards/BoardView")),
  sheet: lazy(() => import("../sheets/SheetView")),
  dashboard: lazy(() => import("../data/DashboardView")),
};
