"use client";
// The mission (essence spec §4.2): "Spokeworks exists to", the mission in
// Fraunces 22px, renamed in place, and the owner's face. A health word only
// once the owner has posted an update.
import { useState } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import type { CanvasMission } from "./canvasModel";
import { HealthWord } from "./GoalTile";
import { Face } from "./PersonHeader";

export function MissionLine({ mission, editable = true }: { mission: CanvasMission; editable?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== mission.title) useInboxStore.getState().updateInitiative(mission.id, { title: next });
  };
  return (
    <div className="oc-mission" data-canvas-mission={mission.ref}>
      <span className="oc-mission-lead">{mission.workspace ? `${mission.workspace} exists to` : "We exist to"}</span>
      {draft !== null ? (
        <input
          className="oc-mission-input" autoFocus value={draft} aria-label="Mission"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") { e.stopPropagation(); setDraft(null); } }}
        />
      ) : (
        <button type="button" className="oc-mission-text" disabled={!editable} title={editable ? "Rename" : undefined} onClick={() => setDraft(mission.title)}>
          {mission.title}
        </button>
      )}
      {mission.health && <HealthWord health={mission.health} />}
      {mission.owner && <Face face={mission.owner} size={18} />}
    </div>
  );
}
