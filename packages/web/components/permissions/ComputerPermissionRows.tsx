import { useComputerPermissions } from "../../hooks/useOsPermissions";
import { isElectron } from "../../lib/desktop";
import { COMPUTER_PERMISSION_KINDS } from "../../lib/osPermissions";
import { PermissionRow } from "./PermissionRow";

// The two grants that let an agent drive the other apps on this Mac. They sit
// beside the microphone and the camera because the human decides them in the
// same sitting — but they are not Codecast's grants. They belong to codecast
// computer, a separate small signed app, which is what keeps the answer alive
// across Codecast updates and keeps the desktop app out of the accessibility
// tree entirely.
//
// Mounting this is what asks for the state, and the answer takes seconds to
// arrive: it launches that helper, which asks macOS about itself. So mount it
// where the rows are on screen and nowhere else, and say that a read is
// running rather than letting two rows appear out of nowhere.
// The click opened System Settings and nothing has changed yet, so reading now
// would spend a helper launch on the answer we already have — and the read that
// matters, when the human comes back, would join that stale one instead of
// asking again. The return to the window is the read.
const noReadOnClick = () => {};

export function ComputerPermissionRows() {
  const { permissions, checking } = useComputerPermissions();
  const answered = COMPUTER_PERMISSION_KINDS.some((k) => permissions[k] !== "unknown");

  // A browser tab has no helper and no grant to show, so it says nothing at
  // all — not even that it is looking.
  if (!isElectron()) return null;

  if (checking && !answered) {
    return (
      <div className="px-4 py-3 text-xs text-sol-text-muted sm:px-5">Checking what codecast computer is allowed to do…</div>
    );
  }

  if (!answered) return null;

  // The helper is named once, above its two rows, so each row can stay
  // short: what the grant lets an agent do, and which macOS list it is in.
  return (
    <>
      <div className="px-4 pt-3 pb-1 sm:px-5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">Agent computer use</div>
        <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-sol-text-muted">
          These two belong to codecast computer, a small helper app installed with Codecast, so Codecast itself
          never holds them.
        </p>
      </div>
      {COMPUTER_PERMISSION_KINDS.map((kind) => (
        <PermissionRow key={kind} kind={kind} readiness={permissions[kind]} onChange={noReadOnClick} />
      ))}
    </>
  );
}
