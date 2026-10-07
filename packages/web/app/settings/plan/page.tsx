// Settings > Plan: the hosted assistant's month as a meter, the plans side by
// side, extra credit, where the month's usage went (costliest first, the
// sub-cent rest folded into a count) and the account's history.
// Every number comes from the wallet (usePlanFigures) and the PLANS catalog;
// every word from the plan rules shared with the phone (components/simple/
// lane.ts). Stripe sends the person back here (BILLING_RETURN), and
// useBillingReturn says how the payment went until the wallet shows it.
import { Check, CircleGauge, CreditCard, History, ListTree, Plus } from "lucide-react";
import { PLANS } from "@codecast/shared/contracts/assistant";
import { SettingsCallout, SettingsPanel, SettingsRow, SettingsSection, SupportSentence } from "../../../components/settings/ui";
import { Button } from "../../../components/ui/button";
import { MeterBar } from "../../../components/plan/UsageMeter";
import { LANE_COPY, TOPUP_AMOUNTS_USD, conversationTitle, ledgerLines, meterLegend, monthShare, planCard, planPoints, planPrice, topupLabel, usageHeadline, workedTimes } from "../../../components/simple/lane";
import { useBilling } from "../../../components/simple/billing";
import { useBillingReturn } from "../../../components/simple/useBillingReturn";
import { planDay, usePlanFigures } from "../../../components/simple/usePlanFigures";
import { useOpenSession } from "../../../hooks/useOpenSession";
import { supportMailto } from "../../../lib/siteLinks";
import { cn } from "@/lib/utils";
import { useInboxStore } from "../../../store/inboxStore";

const WORDS = LANE_COPY.plan;

export default function PlanSettingsPage() {
  const planFigures = usePlanFigures();
  const { wallet, known, plan, month, figures, fill, full, names, resets, lines, history } = planFigures;
  const billing = useBilling();
  const returned = useBillingReturn(wallet);
  const openSession = useOpenSession();
  const openConversation = (id: string) => {
    useInboxStore.getState().closeSettingsModal();
    openSession(id);
  };
  const ledger = ledgerLines(lines, month);

  return (
    <SettingsPanel>
      {returned ? (
        <SettingsCallout tone={returned.tone === "late" ? "warning" : "info"}>
          {returned.support ? <SupportSentence words={{ ...returned.support, before: returned.text }} /> : returned.text}
        </SettingsCallout>
      ) : null}

      <SettingsSection title={WORDS.thisMonth} icon={CircleGauge} description={WORDS.settingsLede} padded>
        <div data-cc-plan-headline className="text-sm text-sol-text">{known ? usageHeadline(figures) : WORDS.checking}</div>
        <MeterBar fill={fill} full={full} known={known} cap={figures.cap_usd} used={figures.used_usd} className="mt-3" />
        {known ? (
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-sol-text-muted">
            {meterLegend(figures, resets, month).map((line) => (
              <span key={line.key}>{line.strong ? <b className="font-semibold text-sol-text tabular-nums">{line.strong}</b> : null}{line.rest}</span>
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={WORDS.plans} icon={CreditCard} padded>
        {billing.known && !billing.available ? (
          <SettingsCallout className="mb-3">
            {WORDS.planCovers(plan)} <SupportSentence words={WORDS.cardClosed} />
          </SettingsCallout>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          {Object.values(PLANS).map((p) => {
            const { current, offer } = planCard(p.id, planFigures, billing);
            return (
              <div key={p.id} data-cc-plan-card data-current={current ? "" : undefined} className={cn("flex flex-col rounded-lg bg-sol-bg/60 p-3.5", current && "ring-1 ring-sol-cyan/60")}>
                <div className="flex items-center justify-between gap-2">
                  <span data-cc-plan-name className="text-sm font-semibold text-sol-text">{p.label}</span>
                  {current ? <span data-cc-plan-yours className="rounded-full bg-sol-cyan/15 px-2 py-0.5 text-[10px] font-medium text-sol-cyan">{WORDS.yours}</span> : null}
                </div>
                <div className="mt-0.5 text-xs text-sol-text-muted">{planPrice(p)}</div>
                <ul className="mt-3 flex-1 space-y-1.5 text-xs text-sol-text-muted">
                  {planPoints(p).map((point) => (
                    <li key={point} className="flex gap-1.5"><Check className="mt-0.5 h-3 w-3 shrink-0 text-sol-cyan" strokeWidth={2.5} />{point}</li>
                  ))}
                </ul>
                {offer === "checkout" ? (
                  <Button variant="cyan" size="sm" className="mt-3" disabled={billing.busy} onClick={() => void billing.checkout({ plan: p.id })}>
                    {WORDS.moveTo(p.label)}
                  </Button>
                ) : offer === "ask" ? (
                  <Button variant="outline" size="sm" className="mt-3 whitespace-normal text-center" asChild>
                    <a href={supportMailto(WORDS.askMoveSubject(p.label))}>{WORDS.askMove(p.label)}</a>
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      {billing.available && wallet?.billing_account ? (
        <SettingsSection title={WORDS.billing} icon={CreditCard}>
          <SettingsRow label={WORDS.manage} description={WORDS.manageNote}>
            <Button variant="outline" size="sm" disabled={billing.busy} onClick={() => void billing.manage()}>
              {WORDS.manage}
            </Button>
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection title={WORDS.extraCredit} icon={Plus} description={WORDS.moreNote} padded>
        {/* While top-ups are closed the tiles stay away: one line says why,
            where greyed buttons beside live plan cards read as broken. */}
        {!(billing.known && !billing.topup) && <div className="flex flex-wrap gap-2">
          {TOPUP_AMOUNTS_USD.map((usd) => {
            const { label, note } = topupLabel(usd, plan);
            return (
              <Button key={usd} variant="outline" className="h-auto flex-col items-start gap-0 px-3 py-2 disabled:opacity-50" disabled={!billing.topup || billing.busy} onClick={() => void billing.checkout({ topup_usd: usd })}>
                <span>{label}</span>
                <span className="text-[11px] font-normal text-sol-text-muted">{note}</span>
              </Button>
            );
          })}
        </div>}
        {billing.known && !billing.topup ? (
          <p className="text-xs text-sol-text-muted">
            <SupportSentence words={WORDS.topupClosed} />
          </p>
        ) : null}
        {billing.error ? <SettingsCallout tone="warning" className="mt-3">{billing.error}</SettingsCallout> : null}
      </SettingsSection>

      {ledger.shown.length > 0 || ledger.small > 0 ? (
        <SettingsSection title={WORDS.where} icon={ListTree}>
          {ledger.shown.map((line) => (
            <button
              key={line.conversation_id}
              type="button"
              onClick={() => openConversation(String(line.conversation_id))}
              className="flex w-full items-center justify-between gap-6 px-4 py-3 text-left transition-colors hover:bg-sol-bg-highlight/40 sm:px-5"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-sol-text">{names.get(String(line.conversation_id)) ?? conversationTitle(null)}</span>
                <span className="mt-0.5 block text-xs text-sol-text-muted">{workedTimes(line.turns)}</span>
              </span>
              <span className="shrink-0 text-sm tabular-nums text-sol-text-muted">{monthShare(line.cost_usd, month)}</span>
            </button>
          ))}
          {ledger.small > 0 ? (
            <div className="px-4 py-3 text-xs text-sol-text-muted sm:px-5">{WORDS.smallLines(ledger.small)}</div>
          ) : null}
        </SettingsSection>
      ) : null}

      {history.length > 0 ? (
        <SettingsSection title={WORDS.history} icon={History}>
          {history.map((h, n) => (
            <SettingsRow key={`${h.at}-${n}`} label={h.text} description={h.detail ? `${planDay(h.at)}, ${h.detail}` : planDay(h.at)} />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPanel>
  );
}
