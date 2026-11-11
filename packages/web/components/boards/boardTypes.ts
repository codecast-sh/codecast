// What the board view uses from the live-artifact foundation (ct-91883). The
// foundation's handle and LiveViewProps satisfy these structurally; the board
// names only the parts it calls so its own code reads clearly.
import type { ArtifactElement, ArtifactOp, ArtifactPosition } from "@codecast/shared/artifacts";

export type BoardEl = ArtifactElement;

export type BoardLive = {
  apply(ops: ArtifactOp[], opts?: { layer?: any }): unknown;
  preview(ops: ArtifactOp[]): void;
  commit(): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  setPresence(p: { position?: ArtifactPosition; selection?: string[]; status?: string }): void;
};

export type BoardTool =
  | "select"
  | "hand"
  | "text"
  | "frame"
  | "sticky"
  | "pen"
  | "shape"
  | "connector"
  | "stamp"
  | "card"
  | "comment";
