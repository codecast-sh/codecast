"use client";
// Removing a source, the one control the overview's header and the Settings
// row share. The press opens the shared review (components/consequential):
// what the purge deletes (issues and how many are open, replays, metric
// watches, app calls), counted by the server (ingest.removeSourcePreview) and
// shown from the store until it answers. While the source is active the
// review opens on Pause, which keeps everything; Remove is a deliberate pick.
import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useOpsGroups, useOpsScope, useOpsWatches } from "../../hooks/useSyncOps";
import { REPLAY_PROVIDERS } from "@codecast/shared/contracts/replay";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { removeSourceLedger, REMOVE_SOURCE_CHOICES, type RemoveSourceChoice } from "../consequential/ledgers";
import { openIssueCount } from "./issuesModel";
import { SOURCE_PROVIDER_LABEL } from "./parts";
import { replayCountShown, useReplayTotal } from "./useReplayTotals";
import type { OpsSource } from "./opsTypes";

export function RemoveSourceButton({ source, className, icon, onRemoved }: { source: Pick<OpsSource, "_id" | "name" | "provider" | "status" | "keyed">; className: string; icon?: boolean; onRemoved?: () => void }) {
  const [reviewing, setReviewing] = useState(false);
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" aria-expanded={reviewing} onClick={() => setReviewing(true)} data-ops-remove-source>
        {icon && <Trash2 className="w-3.5 h-3.5" />}Remove
      </button>
      {reviewing && <RemoveReview source={source} onClose={() => setReviewing(false)} onRemoved={onRemoved} />}
    </>
  );
}

function RemoveReview({ source, onClose, onRemoved }: { source: Pick<OpsSource, "_id" | "name" | "provider" | "status" | "keyed">; onClose: () => void; onRemoved?: () => void }) {
  const canPause = source.status === "active";
  const [choice, setChoice] = useState<RemoveSourceChoice>(canPause ? REMOVE_SOURCE_CHOICES[0] : "Remove");
  const scope = useOpsScope();
  const { data } = useQueryNoThrow(api.ingest.removeSourcePreview, scope === "skip" ? "skip" : { ...scope, source: source._id } as any);
  const groups = useOpsGroups();
  const watches = useOpsWatches();
  const replays = useReplayTotal(source.name);
  // Until the server has counted, the store's rows stand in as floors, marked the same "+" every Ops count uses.
  const local = useMemo(() => {
    const mine = groups.filter((g) => g.source_id === source._id);
    return {
      issues: { n: mine.length, capped: true },
      open: { n: openIssueCount(groups, source._id), capped: true },
      tasked: { n: mine.filter((g) => g.signal_task_id).length, capped: true },
      watches: { n: watches.filter((w) => w.source_id === source._id).length, capped: true },
    };
  }, [groups, watches, source._id]);
  const { source: _ref, ...counted } = data ?? { source: null, ...local, calls: undefined };
  // Replays are the Replays tab badge's own count (useReplayTotal), so the review and the tab say the same number.
  const replayCount = replays ? { n: replayCountShown(replays), capped: replays.capped } : data?.replays ?? { n: 0, capped: true };
  // A provider that never records (an app, CI, a webhook) has no replays to count: the tile is left off, as on the overview.
  const holdsReplays = (REPLAY_PROVIDERS as readonly string[]).includes(source.provider) || replayCount.n > 0;
  const ledger = removeSourceLedger({ ...counted, replays: replayCount, holdsReplays, source: source.name, provider: SOURCE_PROVIDER_LABEL[source.provider], choice, canPause, keyed: source.keyed });
  const confirm = () => {
    onClose();
    const store = useInboxStore.getState();
    if (canPause && choice === "Pause") return store.setOpsSourceStatus(source._id, "paused");
    store.removeOpsSource(source._id);
    onRemoved?.();
  };
  return <SwitchReview ledger={ledger} onClose={onClose} onConfirm={confirm} onPick={(o) => setChoice(o as RemoveSourceChoice)} />;
}
