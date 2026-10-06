// The one way out of a used-up month that works today: extra credit, offered
// as a quiet link where the month ran out (the composer's status line and the
// budget stop notice). It runs the Plan page's own top-up checkout
// (useBilling) for the smallest amount, and shows only while top-ups can be
// bought.
import { useBilling } from "../simple/billing";
import { usePlanMeter } from "../simple/usePlanFigures";
import { TOPUP_AMOUNTS_USD, topupLabel } from "../simple/lane";

export function TopUpLink({ className }: { className?: string }) {
  const billing = useBilling();
  const { plan } = usePlanMeter(false);
  if (!billing.topup) return null;
  const usd = TOPUP_AMOUNTS_USD[0];
  const { label } = topupLabel(usd, plan);
  return (
    <button
      type="button"
      disabled={billing.busy}
      onClick={() => void billing.checkout({ topup_usd: usd })}
      className={`shrink-0 font-medium text-sol-orange underline-offset-2 hover:underline disabled:opacity-60 ${className ?? ""}`}
      title={billing.error ?? undefined}
    >
      {billing.busy ? "Opening checkout…" : `${label} of credit`}
    </button>
  );
}
