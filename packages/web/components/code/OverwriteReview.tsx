// The confirm for writing a file its mode refuses (0444: generated code, a
// checked-out lock file). The daemon writes it only with force=1, keeps the
// mode bits, and still compares the etag, so disk that moved merges first.
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";

export function overwriteLedger(path: string, mode: string): SwitchLedger {
  return {
    name: "Overwrite read-only file",
    subject: path,
    shift: null,
    figures: [{ value: mode, label: "mode, kept", tone: "warn" }],
    rows: [
      { k: "Writes", v: "Your unsaved text" },
      { k: "Mode", v: "Unchanged" },
      { k: "Disk moved", v: "Merges first", tone: "ok" },
      { k: "Undo", v: "Undo, then save" },
    ],
    confirm: "Overwrite",
    keep: "Cancel",
  };
}

export function OverwriteReview({ path, mode, onClose, onConfirm }: { path: string; mode: string; onClose: () => void; onConfirm: () => void }) {
  return <SwitchReview ledger={overwriteLedger(path, mode)} onClose={onClose} onConfirm={onConfirm} />;
}
