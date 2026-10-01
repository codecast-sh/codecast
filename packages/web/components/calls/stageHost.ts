import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { Room } from "livekit-client";
import { LayoutGrid, User, Wand2 } from "lucide-react";

// What the stage's views (StageViews) are told by whoever draws them, and the
// few constants every stage shares. Its own module so the views file exports
// only components (a Fast Refresh boundary) and a guest's page reads none of
// the app: a member's stage (CallStage) and a guest's (app/meet) each hand
// the views a host, and the views never ask where they are.

export type StageFollowChip = ComponentType<{ identity: string; name: string; variant: "tile" | "row"; always?: boolean }>;

export type StageHost = {
  /** The room the tiles are in: whose pointer is mine, where mine goes. */
  getRoom: () => Room | null;
  /** Following someone in the app (a member's stage only). */
  FollowChip?: StageFollowChip;
  /** Who the viewer is following, read reactively. A hook, called once per
   *  render of the rows that ring the followed face. */
  useFollowLeader?: () => string | null;
  /** What the viewer may do to this participant, beside their name (a
   *  member putting a guest out). Null for nothing. */
  personActions?: (p: { identity: string; name: string; variant: "tile" | "row" }) => ReactNode;
  /** The viewer's own identity, so their row in a list reads "you" the way
   *  their own tile does. */
  selfIdentity?: string;
};

export const noFollowLeader = () => null;
const NO_HOST: StageHost = { getRoom: () => null };
const StageHostContext = createContext<StageHost>(NO_HOST);

export const StageHostProvider = StageHostContext.Provider;

export function useStageHost(): StageHost {
  return useContext(StageHostContext);
}

// Roster lookup for a tile: is this person muted right now?
export const isMuted = (roster: any[], identity: string) =>
  !!roster.find((m) => String(m.user_id) === identity)?.muted;

// The control bar's round buttons, the same on a member's stage and a guest's:
// borderless, state read by tint (cyan camera, violet share, red muted).
export const STAGE_CTL = "rounded-full p-2 transition-colors";
export const STAGE_CTL_IDLE = "text-sol-text-muted hover:bg-white/10 hover:text-sol-text";

// The one outline the stage allows itself: a soft cyan ring with a faint
// halo on whoever is speaking. Silent tiles have no border at all: the gap
// between them is the frame.
export const SPEAKING_RING = "ring-2 ring-sol-cyan/80 shadow-[0_0_0_5px_rgba(42,161,152,0.16)]";

// The three ways to see a call, for whichever view switch draws them.
export type StageView = "auto" | "speaker" | "grid";

export const STAGE_VIEWS = [
  { key: "auto", icon: Wand2, label: "auto", hint: "Auto: shares take the stage" },
  { key: "speaker", icon: User, label: "speaker", hint: "Speaker: follow whoever is talking (click a tile to pin)" },
  { key: "grid", icon: LayoutGrid, label: "grid", hint: "Grid: everyone equal" },
] as const;
