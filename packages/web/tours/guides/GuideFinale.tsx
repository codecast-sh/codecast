"use client";
// The guide's last screen: what the feature gives a team, and its switch
// (FeatureSwitches, the team settings' own). With the feature on, Open goes to
// its page and starts that page's short tour when it has one.
import { useRouter } from "next/navigation";
import { Check, RotateCcw } from "lucide-react";
import { TEAM_FEATURES, workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { endTour, startTour } from "../engine";
import { FeatureSwitches } from "./FeatureSwitches";
import { guideIcon } from "./guideIcons";
import type { GuideDef } from "./types";

export function GuideFinale({ guide, onBack, onClose }: { guide: GuideDef; onBack: () => void; onClose: () => void }) {
  const router = useRouter();
  const on = useInboxStore((s) => workspaceFeatureEnabled(s.teams || [], s.clientState.ui?.active_team_id, guide.feature));
  const desc = TEAM_FEATURES.find((f) => f.key === guide.feature)?.desc;
  const Icon = guideIcon(guide.feature);

  const open = () => {
    endTour("finished");
    router.push(guide.home);
    if (guide.pageTour) window.setTimeout(() => startTour(guide.pageTour!, { replay: true }), 400);
  };

  return (
    <div className="guide-finale" data-guide-finale>
      <div className="guide-finale-left">
        <span className="guide-finale-icon"><Icon className="w-6 h-6" strokeWidth={1.6} /></span>
        <h2 className="guide-finale-title">{on ? `${guide.name} is on` : `Turn on ${guide.name}`}</h2>
        {desc && <p className="guide-finale-desc">{desc}</p>}
        <ul className="guide-gives">
          {guide.gives.map((g, i) => (
            <li key={g} style={{ animationDelay: `${120 + i * 70}ms` }}><Check className="w-3.5 h-3.5 shrink-0" strokeWidth={2.4} /><span>{g}</span></li>
          ))}
        </ul>
      </div>

      <div className="guide-finale-right">
        <FeatureSwitches feature={guide.feature} name={guide.name} />
        <div className="guide-finale-actions">
          <button type="button" className="guide-btn guide-btn-primary guide-btn-big" onClick={open} disabled={!on} data-guide-open>
            Open {guide.name}
          </button>
          <button type="button" className="guide-btn" onClick={onBack}>Back</button>
          <button type="button" className="guide-btn" onClick={() => { onClose(); window.setTimeout(() => startTour(guide.id, { replay: true }), 0); }} title="Watch from the start" aria-label="Watch from the start">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="guide-dim guide-finale-foot">Off hides all of it for the whole team. The switch is also in Settings, Team.</p>
      </div>
    </div>
  );
}
