"use client";
// Rotating a keyed source's ingest key, the one control the overview's header
// and the Settings row share. The press opens the shared review
// (components/consequential): the events the old key carries, and how long it
// keeps working (a day by default, at once for a leaked key). While a
// rotated-out key still works, a chip counts down to its end; ending it now opens
// the same review, with what the old key still carries.
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { endOldKeyLedger, rotateKeyLedger, OLD_KEY_CHOICES, type OldKeyChoice } from "../consequential/ledgers";
import { relTimeShort } from "../../lib/utils";
import type { Reveal } from "./SourcesSection";
import type { OpsSource } from "./opsTypes";

const HOUR = 3600_000;

export function RotateKeyButton({ source, events24h, onRotated, className, icon }: { source: Pick<OpsSource, "_id" | "short_id" | "name" | "workspace" | "key_prefix" | "old_key_prefix" | "old_key_until" | "old_key_last_at" | "old_key_events">; events24h: number; onRotated: (r: Reveal) => void; className: string; icon?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [choice, setChoice] = useState<OldKeyChoice>(OLD_KEY_CHOICES[0]);
  const [rotating, setRotating] = useState(false);
  const [ending, setEnding] = useState(false);
  const now = useCoarseNow(60_000);
  const store = () => useInboxStore.getState();
  const left = source.old_key_until ? source.old_key_until - now : 0;
  const leftText = left >= HOUR ? `${Math.floor(left / HOUR)}h` : `${Math.max(1, Math.round(left / 60_000))}m`;
  const rotate = async () => {
    setReviewing(false);
    setRotating(true);
    const endOld = choice === "Ends now";
    try {
      const res = await store().rotateOpsSourceKey(source._id, endOld);
      if (res?.ingest_key) onRotated({ name: source.name, key: res.ingest_key, rotated: true, id: source.short_id, workspace: source.workspace, ...(endOld ? {} : { oldUntil: Date.now() + 24 * HOUR }) });
    } finally {
      setRotating(false);
      setChoice(OLD_KEY_CHOICES[0]);
    }
  };
  return (
    <>
      {left > 0 && (
        <span className="ops-key-grace" title={`${source.old_key_prefix ?? "The old key"}… is accepted until ${new Date(source.old_key_until!).toLocaleString()}`} data-ops-key-grace>
          <span className="ops-num">old key {leftText}</span>
          <button type="button" className={className} aria-haspopup="dialog" onClick={() => setEnding(true)} data-ops-end-old-key>End</button>
        </span>
      )}
      <button type="button" className={className} disabled={rotating} onClick={() => setReviewing(true)} data-ops-rotate-key>
        {icon && <KeyRound className="w-3.5 h-3.5" />}
        {rotating ? "Rotating" : "Rotate key"}
      </button>
      {ending && left > 0 && (
        <SwitchReview
          ledger={endOldKeyLedger({ source: source.name, prefix: source.old_key_prefix, until: source.old_key_until!, lastAt: source.old_key_last_at ?? null, events: source.old_key_events ?? 0, ago: (t) => (now - t < 60_000 ? "Just now" : `${relTimeShort(t, now)} ago`), left: leftText })}
          onClose={() => setEnding(false)}
          onConfirm={() => { setEnding(false); store().endOpsSourceOldKey(source._id); }}
        />
      )}
      {reviewing && (
        <SwitchReview
          ledger={rotateKeyLedger({ source: source.name, prefix: source.key_prefix, events24h, choice })}
          onClose={() => { setReviewing(false); setChoice(OLD_KEY_CHOICES[0]); }}
          onConfirm={() => void rotate()}
          onPick={(o) => setChoice(o as OldKeyChoice)}
        />
      )}
    </>
  );
}
