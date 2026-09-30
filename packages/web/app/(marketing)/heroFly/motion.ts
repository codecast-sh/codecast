/**
 * Every chapter's motion, gathered per surface for `timeline.ts`. Pure data:
 * the motion files import nothing but `world.ts` and the fixtures, so the
 * timeline stays a pure function that tests and the prerender can load.
 */

import type { ChapterMotion } from "./chapters/contract";
import { motion as automation } from "./chapters/automation.motion";
import { motion as conversation } from "./chapters/conversation.motion";
import { motion as decide } from "./chapters/decide.motion";
import { motion as fanout } from "./chapters/fanout.motion";
import { motion as inbox } from "./chapters/inbox.motion";
import { motion as integrations } from "./chapters/integrations.motion";
import { motion as memory } from "./chapters/memory.motion";
import { motion as phone } from "./chapters/phone.motion";
import { motion as publish } from "./chapters/publish.motion";
import { motion as remote } from "./chapters/remote.motion";
import { motion as talk } from "./chapters/talk.motion";
import { motion as team } from "./chapters/team.motion";
import { motion as work } from "./chapters/work.motion";
import { SURFACES, type ArcPath, type Beat, type ChapterId, type Flyer, type SurfaceId, type TextBeat } from "./world";

export const MOTIONS: Record<ChapterId, ChapterMotion> = {
  inbox, conversation, fanout, phone, talk, decide, work, automation, team, integrations, publish, memory, remote,
};

const perSurface = <T>(pick: (m: ChapterMotion) => Partial<Record<SurfaceId, T[]>> | undefined) =>
  Object.fromEntries(
    SURFACES.map((s) => [s.id, Object.values(MOTIONS).flatMap((m) => pick(m)?.[s.id] ?? [])]),
  ) as Record<SurfaceId, T[]>;

export const BEATS: Record<SurfaceId, Beat[]> = perSurface((m) => m.beats);
export const TEXTS: Record<SurfaceId, TextBeat[]> = perSurface((m) => m.texts);
export const FLYERS: Flyer[] = Object.values(MOTIONS).flatMap((m) => m.flyers ?? []);
export const ARCS: ArcPath[] = Object.values(MOTIONS).flatMap((m) => m.arcs ?? []);
