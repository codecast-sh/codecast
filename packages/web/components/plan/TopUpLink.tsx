// The one way out of a used-up month that works today: extra credit, offered
// as a quiet link where the month ran out (the composer's status line and the
// budget stop notice). It runs the Plan page's own top-up checkout
// (useBilling) for the smallest amount. While top-ups can't be bought it
// opens the Plan page instead, which says what can be done meanwhile, so a
// held line always has one way forward.
import { useInboxStore } from "../../store/inboxStore";
import { useBilling } from "../simple/billing";
import { usePlanMeter } from "../simple/usePlanFigures";
import { TOPUP_AMOUNTS_USD, topupLabel } from "../simple/lane";

export function TopUpLink({ className }: { className?: string }) {
  const billing = useBilling();
  const { plan } = usePlanMeter(false);
  const linkClass = `shrink-0 font-medium text-sol-orange underline-offset-2 hover:underline disabled:opacity-60 ${className ?? ""}`;
  if (!billing.topup) {
    return (
      <button type="button" onClick={() => useInboxStore.getState().openSettingsModal("plan")} className={linkClass}>
        See your plan
      </button>
    );
  }
  const usd = TOPUP_AMOUNTS_USD[0];
  const { label } = topupLabel(usd, plan);
  return (
    <button
      type="button"
      disabled={billing.busy}
      onClick={() => void billing.checkout({ topup_usd: usd })}
      className={linkClass}
      title={billing.error ?? undefined}
    >
      {billing.busy ? "Opening checkout…" : `${label} of credit`}
    </button>
  );
}
