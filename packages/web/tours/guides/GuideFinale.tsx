"use client";
// The guide's last screen: what the feature gives a team, and its switch.
// The switch is the team settings one (TeamFeaturesEditor), the same store
// action, so flipping it here is flipping it there: the sidebar row appears
// as it is pressed, and a refusal puts it back. An admin sees the switch for
// the team they are in (in the personal workspace, every team they run); a
// member sees who can turn it on. With the feature on, Open goes to its page
// and starts that page's own short tour.
import { useRouter } from "next/navigation";
import { Check, RotateCcw } from "lucide-react";
import { TEAM_FEATURES, teamFeatureEnabled, workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { Switch } from "../../components/ui/switch";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { endTour, startTour } from "../engine";
import { guideIcon } from "./guideIcons";
import type { GuideDef } from "./types";

export function GuideFinale({ guide, onBack, onClose }: { guide: GuideDef; onBack: () => void; onClose: () => void }) {
  const router = useRouter();
  const s = useTrackedStore([
    (st) => st.teams,
    (st) => activeTeamIdOf(st),
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.teamMembers,
  ]);
  const teams: any[] = (s.teams || []).filter(Boolean);
  const activeId = activeTeamIdOf(s);
  const active = teams.find((t) => String(t._id) === String(activeId)) ?? null;
  // The teams whose switch this screen shows: the one you are in, or in your
  // personal workspace every team you run.
  const shown = active ? [active] : teams.filter((t) => t.role === "admin" || t.role === "owner");
  const on = workspaceFeatureEnabled(teams, s.clientState.ui?.active_team_id, guide.feature);
  const admins = active && active.role !== "admin" && active.role !== "owner"
    ? (s.teamMembers || []).filter((m: any) => m && (m.role === "admin" || m.role === "owner")).map((m: any) => m.name || m.github_username || "an admin")
    : [];
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
        <div className="guide-switches">
          {shown.length === 0 && <p className="guide-dim">Switches are per team. Create or join a team to turn {guide.name} on.</p>}
          {shown.map((t) => {
            const isAdmin = t.role === "admin" || t.role === "owner";
            const teamOn = teamFeatureEnabled(t, guide.feature);
            return (
              <label key={String(t._id)} className="guide-switch-row" data-on={teamOn ? "" : undefined} data-guide-switch={String(t._id)}>
                <span className="guide-switch-team">
                  <span className="guide-switch-name">{t.name}</span>
                  <span className="guide-switch-state">{teamOn ? "On for everyone on the team" : isAdmin ? "Off" : "Off · an admin turns it on"}</span>
                </span>
                <Switch
                  checked={teamOn}
                  disabled={!isAdmin}
                  onCheckedChange={(v) => useInboxStore.getState().setTeamFeature(String(t._id), guide.feature, v)}
                  aria-label={`${guide.name} for ${t.name}`}
                />
              </label>
            );
          })}
          {admins.length > 0 && !on && (
            <p className="guide-dim">Ask {admins.slice(0, 3).join(", ")} to turn it on in Settings, Team, Features.</p>
          )}
        </div>
        <div className="guide-finale-actions">
          <button type="button" className="guide-btn guide-btn-primary guide-btn-big" onClick={open} disabled={!on} data-guide-open>
            Open {guide.name}
          </button>
          <button type="button" className="guide-btn" onClick={onBack}>Back</button>
          <button type="button" className="guide-btn" onClick={() => { onClose(); window.setTimeout(() => startTour(guide.id, { replay: true }), 0); }} title="Watch from the start">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="guide-dim guide-finale-foot">Turn it off any time in Settings, Team, Features. Off hides all of it for the whole team.</p>
      </div>
    </div>
  );
}
