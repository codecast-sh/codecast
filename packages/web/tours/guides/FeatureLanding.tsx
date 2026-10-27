"use client";
// The page a team feature's address shows while the feature is not on for the
// workspace (/org, /flows, an old link): what the feature is, a chapter of its
// guide playing on a loop, what it gives a team, its switch, and the whole
// guide one press away. It is the door the app keeps open to a feature a team
// never decided on, and the honest landing for one an admin turned off.
import { useState } from "react";
import { Check, Play } from "lucide-react";
import { TEAM_FEATURES, workspaceFeatureState, type TeamFeatureKey } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { startTour } from "../engine";
import { watchGuideLabel } from "../registry";
import { FeatureSwitches } from "./FeatureSwitches";
import { ScaledStage } from "./GuidePlayer";
import { GUIDES } from "./guides";
import { guideIcon } from "./guideIcons";
import type { GuideChapter } from "./types";
import "./guides.css";

/** The chapter each landing plays: the one that shows the feature at work. */
const PREVIEW: Partial<Record<TeamFeatureKey, string>> = { org: "decisions", line: "run" };

export default function FeatureLanding({ feature }: { feature: TeamFeatureKey }) {
  const guide = GUIDES.find((g) => g.feature === feature);
  const state = useInboxStore((s) => workspaceFeatureState(s.teams || [], s.clientState.ui?.active_team_id, feature));
  if (!guide) return null;
  const Icon = guideIcon(feature);
  const desc = TEAM_FEATURES.find((f) => f.key === feature)?.desc;
  const chapter = guide.chapters.find((c) => c.id === PREVIEW[feature]) ?? guide.chapters[0];

  return (
    <div className="feature-landing" style={{ "--guide-accent": guide.accent } as React.CSSProperties} data-feature-landing={feature} data-feature-state={state}>
      <div className="guide-atmos" aria-hidden />
      <div className="feature-landing-inner">
        <div className="feature-landing-head">
          <span className="guide-finale-icon"><Icon className="w-6 h-6" strokeWidth={1.6} /></span>
          <div className="min-w-0">
            <h1 className="feature-landing-title">{guide.name}{state === "offer" && <span className="feature-landing-new">NEW</span>}</h1>
            <p className="guide-finale-desc">{desc}</p>
          </div>
        </div>
        <div className="feature-landing-side">
          <button type="button" className="guide-btn guide-btn-primary guide-btn-big w-full justify-center" onClick={() => startTour(guide.id, { replay: true })} data-feature-landing-guide>
            <Play className="w-3.5 h-3.5" /> {watchGuideLabel(guide.id)}
          </button>
          <FeatureSwitches feature={feature} name={guide.name} />
        </div>
        <button type="button" className="feature-landing-preview" onClick={() => startTour(guide.id, { replay: true })} aria-label={`Watch the ${guide.name} guide`}>
          <ScenePreview chapter={chapter} />
          <span className="feature-landing-preview-cap"><Play className="w-3 h-3" /><span>{chapter.title}</span><span className="guide-dim">a chapter of the guide, on a loop</span></span>
        </button>
        <ul className="feature-landing-gives">
          {guide.gives.map((g, i) => (
            <li key={g} style={{ animationDelay: `${120 + i * 70}ms` }}><Check className="w-3.5 h-3.5 shrink-0" strokeWidth={2.4} /><span>{g}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** One chapter on a loop, every press already made, at the size its box allows. */
function ScenePreview({ chapter }: { chapter: GuideChapter }) {
  const [beat, setBeat] = useState(0);
  useWatchEffect(() => {
    const hold = chapter.beats[beat]?.hold ?? 3600;
    const t = window.setTimeout(() => setBeat((b) => (b + 1) % chapter.beats.length), beat === chapter.beats.length - 1 ? hold + 1600 : hold);
    return () => window.clearTimeout(t);
  }, [beat, chapter]);
  const Scene = chapter.Scene;
  return (
    <ScaledStage max={1} className="feature-landing-stage">
      <div className="guide-scene" key={beat === 0 ? "loop" : "run"} aria-hidden><Scene beat={beat} act={() => {}} waiting={false} /></div>
    </ScaledStage>
  );
}
