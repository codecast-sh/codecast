// The plan: this month's usage as a meter, the plans side by side, and the
// ways to get more. Every number comes from the wallet (useWallet) and the
// PLANS catalog; nothing here holds a price of its own.
import { useMemo } from "react";
import { Link } from "react-router";
import { Check, CircleAlert, Info } from "lucide-react";
import { PLANS, planOf } from "@codecast/shared/contracts/assistant";
import { useWallet } from "../../../hooks/useWallet";
import { TOPUP_AMOUNTS_USD, conversationPath, conversationTitle, dollars, meterFill, planPoints, planPrice, upgradesFrom, usageHeadline } from "../../../components/simple/lane";
import { useBilling } from "../../../components/simple/billing";
import { useLaneConversations } from "../../../components/simple/useLane";

function resetDay(at: number | null): string | null {
  return at ? new Date(at).toLocaleDateString([], { month: "long", day: "numeric" }) : null;
}

export default function SimplePlan() {
  const { wallet } = useWallet();
  const billing = useBilling();
  const plan = planOf(wallet?.plan);
  const figures = wallet ?? { used_usd: 0, reserved_usd: 0, cap_usd: plan.included_usd, topup_usd: 0, remaining_usd: plan.included_usd, period_end: null, conversations: [] };
  const fill = meterFill(figures);
  const full = figures.used_usd >= figures.cap_usd;
  const upgrades = useMemo(() => new Set(upgradesFrom(plan.id).map((p) => p.id)), [plan.id]);
  const conversations = useLaneConversations();
  const names = useMemo(() => new Map(conversations.map((c) => [String(c._id), conversationTitle(c)])), [conversations]);
  const resets = resetDay(figures.period_end);
  const lines = wallet?.conversations ?? [];

  return (
    <main>
      <h1 className="sl-page-title sl-rise">Your plan</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        Your plan covers the work I do each month: reading, writing, searching and checking in.
      </p>

      <section className="sl-card sl-meter sl-rise" style={{ ["--i" as any]: 2 }} aria-label="This month">
        <div className="sl-meter-head">{usageHeadline(figures)}</div>
        <div className="sl-meter-bar" role="meter" aria-valuemin={0} aria-valuemax={figures.cap_usd} aria-valuenow={Math.min(figures.used_usd, figures.cap_usd)} aria-label="Allowance used">
          <div className={`sl-meter-used${full ? " is-full" : ""}`} style={{ width: `${fill.used * 100}%` }} />
          <div className="sl-meter-held" style={{ width: `${fill.held * 100}%` }} />
        </div>
        <div className="sl-meter-legend">
          <span><b>{dollars(figures.used_usd)}</b> of {dollars(figures.cap_usd)} used</span>
          {figures.reserved_usd > 0 ? <span>{dollars(figures.reserved_usd)} set aside for work in progress</span> : null}
          {figures.topup_usd > 0 ? <span><b>{dollars(figures.topup_usd)}</b> extra credit</span> : null}
          {resets ? <span>Starts fresh {resets}</span> : null}
        </div>
      </section>

      <section className="sl-section sl-rise" style={{ ["--i" as any]: 3 }} aria-label="Plans">
        <h2 className="sl-section-head">Plans</h2>
        <div className="sl-plans">
          {Object.values(PLANS).map((p) => {
            const current = p.id === plan.id;
            return (
              <div key={p.id} className={`sl-card sl-plan${current ? " is-current" : ""}`}>
                <div className="sl-plan-name">
                  {p.label}
                  {current ? <span className="sl-pill">Your plan</span> : null}
                </div>
                <div className="sl-plan-price">{planPrice(p)}</div>
                <ul>
                  {planPoints(p).map((point) => (
                    <li key={point}><Check size={14} strokeWidth={2.5} />{point}</li>
                  ))}
                </ul>
                {upgrades.has(p.id) ? (
                  <button type="button" className="sl-btn is-yes" disabled={!billing.available || billing.busy} onClick={() => void billing.checkout({ plan: p.id })}>
                    {`Move to ${p.label}`}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="sl-section sl-rise" style={{ ["--i" as any]: 4 }} aria-label="Extra credit">
        <h2 className="sl-section-head">Need a little more this month?</h2>
        <div className="sl-card" style={{ padding: "1rem 1.05rem" }}>
          <p className="sl-muted" style={{ margin: "0 0 0.8rem", fontSize: "0.93rem" }}>
            Extra credit is used after your plan's allowance and carries over until it's spent.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {TOPUP_AMOUNTS_USD.map((usd) => (
              <button key={usd} type="button" className="sl-btn is-plain" disabled={!billing.available || billing.busy} onClick={() => void billing.checkout({ topup_usd: usd })}>
                {`Add ${dollars(usd).replace(/\.00$/, "")}`}
              </button>
            ))}
          </div>
        </div>
        {billing.error ? (
          <div className="sl-callout is-sun" style={{ marginTop: "0.75rem" }}>
            <CircleAlert size={18} />
            <span>{billing.error}</span>
          </div>
        ) : null}
        {!billing.available ? (
          <div className="sl-callout" style={{ marginTop: "0.75rem" }}>
            <Info size={18} />
            <span>
              Paying by card isn't open yet, so these buttons are resting. If you need more room before then,{" "}
              <Link to="/support" style={{ color: "inherit" }}>tell us</Link> and we'll add it by hand.
            </span>
          </div>
        ) : null}
      </section>

      {lines.length > 0 ? (
        <section className="sl-section sl-rise" style={{ ["--i" as any]: 5 }} aria-label="Where it went">
          <h2 className="sl-section-head">Where it went</h2>
          <div className="sl-list">
            {lines.map((line) => (
              <Link key={line.conversation_id} to={conversationPath(String(line.conversation_id))} className="sl-row">
                <span className="sl-row-main">
                  <span className="sl-row-title" style={{ display: "block" }}>{names.get(String(line.conversation_id)) ?? conversationTitle(null)}</span>
                  <span className="sl-row-sub" style={{ display: "block" }}>{line.turns === 1 ? "Once" : `${line.turns} times`}</span>
                </span>
                <span className="sl-row-aside">{dollars(line.cost_usd)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
