// The plan: this month's usage as a meter, the plans side by side, and the
// ways to get more. Every number comes from the wallet (useWallet) and the
// PLANS catalog; nothing here holds a price of its own.
import { Link, useSearchParams } from "react-router";
import { Check, CircleAlert, CircleCheck, Info } from "lucide-react";
import { PLANS } from "@codecast/shared/contracts/assistant";
import { LANE_COPY, TOPUP_AMOUNTS_USD, billingReturnNote, conversationPath, conversationTitle, dollars, meterLegend, planCard, planPoints, planPrice, topupLabel, usageHeadline, workedTimes } from "../../../components/simple/lane";
import { useBilling } from "../../../components/simple/billing";
import { supportMailto } from "../../../lib/siteLinks";
import { planDay, usePlanFigures } from "../../../components/simple/usePlanFigures";

const WORDS = LANE_COPY.plan;

export default function SimplePlan() {
  const planFigures = usePlanFigures();
  const { wallet, known, figures, fill, full, names, resets, lines, history } = planFigures;
  const billing = useBilling();
  const [params] = useSearchParams();
  const returned = billingReturnNote(params.get("billing"));

  return (
    <main>
      <h1 className="sl-page-title sl-rise">{WORDS.title}</h1>
      <p className="sl-lede sl-rise" style={{ ["--i" as any]: 1 }}>
        {WORDS.lede}
      </p>

      {returned ? (
        <div className="sl-callout sl-rise" style={{ marginBottom: "0.9rem" }}>
          <CircleCheck size={18} />
          <span>{returned}</span>
        </div>
      ) : null}

      <section className="sl-card sl-meter sl-rise" style={{ ["--i" as any]: 2 }} aria-label={WORDS.thisMonth}>
        <div className="sl-meter-head">{known ? usageHeadline(figures) : WORDS.checking}</div>
        <div className="sl-meter-bar" role="meter" aria-valuemin={0} aria-valuemax={figures.cap_usd} aria-valuenow={Math.min(figures.used_usd, figures.cap_usd)} aria-label={LANE_COPY.plan.meterLabel}>
          <div className={`sl-meter-used${full ? " is-full" : ""}`} style={{ width: `${known ? fill.used * 100 : 0}%` }} />
          <div className="sl-meter-held" style={{ width: `${known ? fill.held * 100 : 0}%` }} />
        </div>
        {known ? <div className="sl-meter-legend">
          {meterLegend(figures, resets).map((line) => (
            <span key={line.key}>{line.strong ? <b>{line.strong}</b> : null}{line.rest}</span>
          ))}
        </div> : null}
      </section>

      <section className="sl-section sl-rise" style={{ ["--i" as any]: 3 }} aria-label={WORDS.plans}>
        <h2 className="sl-section-head">{WORDS.plans}</h2>
        {billing.known && !billing.available ? (
          <div className="sl-callout" style={{ marginBottom: "0.75rem" }}>
            <Info size={18} />
            <span>
              {WORDS.cardClosed.before}
              <a href={supportMailto(WORDS.cardClosedSubject)} style={{ color: "inherit" }}>{WORDS.cardClosed.link}</a>
              {WORDS.cardClosed.after}
            </span>
          </div>
        ) : null}
        <div className="sl-plans">
          {Object.values(PLANS).map((p) => {
            const { current, offer } = planCard(p.id, planFigures, billing);
            return (
              <div key={p.id} className={`sl-card sl-plan${current ? " is-current" : ""}`}>
                <div className="sl-plan-name">
                  {p.label}
                  {current ? <span className="sl-pill">{WORDS.yours}</span> : null}
                </div>
                <div className="sl-plan-price">{planPrice(p)}</div>
                <ul>
                  {planPoints(p).map((point) => (
                    <li key={point}><Check size={14} strokeWidth={2.5} />{point}</li>
                  ))}
                </ul>
                {offer === "checkout" ? (
                  <button type="button" className="sl-btn is-yes" disabled={billing.busy} onClick={() => void billing.checkout({ plan: p.id })}>
                    {WORDS.moveTo(p.label)}
                  </button>
                ) : offer === "ask" ? (
                  <a href={supportMailto(WORDS.askMoveSubject(p.label))} className="sl-btn is-plain">{WORDS.askMove(p.label)}</a>
                ) : null}
              </div>
            );
          })}
        </div>
        {billing.available && wallet?.billing_account ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.6rem", marginTop: "0.8rem" }}>
            <button type="button" className="sl-btn is-plain" disabled={billing.busy} onClick={() => void billing.manage()}>
              {WORDS.manage}
            </button>
            <span className="sl-muted" style={{ fontSize: "0.9rem" }}>{WORDS.manageNote}</span>
          </div>
        ) : null}
      </section>

      <section className="sl-section sl-rise" style={{ ["--i" as any]: 4 }} aria-label={WORDS.extraCredit}>
        <h2 className="sl-section-head">{WORDS.more}</h2>
        <div className="sl-card" style={{ padding: "1rem 1.05rem" }}>
          <p className="sl-muted" style={{ margin: "0 0 0.8rem", fontSize: "0.93rem" }}>
            {WORDS.moreNote}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {TOPUP_AMOUNTS_USD.map((usd) => (
              <button key={usd} type="button" className="sl-btn is-plain sl-topup" disabled={!billing.topup || billing.busy} onClick={() => void billing.checkout({ topup_usd: usd })}>
                {topupLabel(usd).label}
                <small>{topupLabel(usd).note}</small>
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
      </section>

      {lines.length > 0 ? (
        <section className="sl-section sl-rise" style={{ ["--i" as any]: 5 }} aria-label={WORDS.where}>
          <h2 className="sl-section-head">{WORDS.where}</h2>
          <div className="sl-list">
            {lines.map((line) => (
              <Link key={line.conversation_id} to={conversationPath(String(line.conversation_id))} className="sl-row">
                <span className="sl-row-main">
                  <span className="sl-row-title" style={{ display: "block" }}>{names.get(String(line.conversation_id)) ?? conversationTitle(null)}</span>
                  <span className="sl-row-sub" style={{ display: "block" }}>{workedTimes(line.turns)}</span>
                </span>
                <span className="sl-row-aside">{dollars(line.cost_usd)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="sl-section sl-rise" style={{ ["--i" as any]: 6 }} aria-label={WORDS.history}>
          <h2 className="sl-section-head">{WORDS.history}</h2>
          <div className="sl-list">
            {history.map((h, n) => (
              <div key={`${h.at}-${n}`} className="sl-row">
                <span className="sl-row-main">
                  <span className="sl-row-title" style={{ display: "block" }}>{h.text}</span>
                  <span className="sl-row-sub" style={{ display: "block" }}>{h.detail ? `${planDay(h.at)}, ${h.detail}` : planDay(h.at)}</span>
                </span>
                {h.amount ? <span className="sl-row-aside">{h.amount}</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
