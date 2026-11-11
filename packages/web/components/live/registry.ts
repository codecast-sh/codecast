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
  /** What the artifact downloads as; the shell's top-bar menu lists them and saves "<title>.<ext>". Null offers none. */
  setExports: (exports: LiveExport[] | null) => void;
  /** A file import the shell's menu offers above the downloads; null offers none. */
  setImport: (imp: LiveImport | null) => void;
  /** Open the comments panel: on `thread` (as ?c= does), or on a new comment anchored to `anchor` with the box focused. */
  openComments: (opts?: { anchor?: string; thread?: string }) => void;
  /** The header's type label when the view is something more specific than its type ("Scrollyteller"); null restores it. */
  setTypeLabel: (label: string | null) => void;
};

/** A file import: the shell opens the file picker with `accept` and hands the chosen files to `run`. */
export type LiveImport = { label: string; accept: string; multiple?: boolean; run: (files: File[]) => void };

/** One download the artifact offers. `run` produces the file; the shell names, saves and reports it. */
export type LiveExport = {
  format: "png" | "svg" | "pdf" | "csv" | "xlsx";
  /** Menu words when the format alone does not say it ("PNG, 2x"). */
  label?: string;
  /** Offer a "selection only" entry while something is selected. */
  selectionAware?: boolean;
  run: (opts: { selection: string[] }) => Promise<Blob>;
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
