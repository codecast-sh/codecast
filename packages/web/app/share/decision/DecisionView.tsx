// A decision as the decision and stack share pages draw it: the question's
// context, then every option as a card, the chosen one marked and the
// recommended one flagged while it is still open.
import { Check, Star } from "lucide-react";
import { Pill, Prose, Callout, TONE } from "../SharedObjectPage";

export type SharedDecision = {
  context_md: string | null;
  status: string;
  options: Array<{ label: string; description: string | null; body_md: string | null; cost: string | null; risk: string | null; evidence: Array<{ label: string; url: string }> }>;
  default_option: number | null;
  answer_index: number | null;
  answer_text: string | null;
};

export function decisionOutcome(d: SharedDecision): string | null {
  if (d.status !== "answered") return null;
  return d.answer_index != null ? (d.options[d.answer_index]?.label ?? null) : d.answer_text;
}

export function DecisionOptions({ d }: { d: SharedDecision }) {
  const open = d.status === "pending";
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {d.options.map((o, i) => {
        const chosen = d.status === "answered" && d.answer_index === i;
        const recommended = open && d.default_option === i;
        const tone = chosen ? TONE.green : recommended ? TONE.cyan : null;
        return (
          <div
            key={i}
            style={{
              padding: "16px 18px",
              borderRadius: 14,
              border: `1px solid ${tone ? `color-mix(in srgb, ${tone} 45%, transparent)` : "var(--rule)"}`,
              background: tone ? `color-mix(in srgb, ${tone} 7%, var(--paper))` : "color-mix(in srgb, var(--paper-alt) 45%, transparent)",
              opacity: d.status === "answered" && !chosen ? 0.72 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--ink-dim)" }}>{i + 1}</span>
              <span style={{ fontFamily: "var(--serif)", fontSize: 19, fontWeight: 600, color: "var(--ink)" }}>{o.label}</span>
              {chosen && <Pill tone="green"><Check size={11} /> Chosen</Pill>}
              {recommended && <Pill tone="cyan"><Star size={11} /> Recommended</Pill>}
            </div>
            {o.description && <p style={{ margin: "8px 0 0", fontFamily: "var(--serif)", fontSize: 16, lineHeight: 1.55, color: "var(--ink-soft)" }}>{o.description}</p>}
            {o.body_md && <div style={{ marginTop: 10 }}><Prose content={o.body_md} compact /></div>}
            {(o.cost || o.risk) && (
              <div className="share-meta" style={{ marginTop: 12 }}>
                {o.cost && <span>cost: <strong>{o.cost}</strong></span>}
                {o.risk && <span>risk: <strong>{o.risk}</strong></span>}
              </div>
            )}
            {o.evidence.length > 0 && (
              <div className="share-meta" style={{ marginTop: 10 }}>
                {o.evidence.map((e) => (
                  <a key={e.url} href={e.url} target="_blank" rel="noreferrer" style={{ color: TONE.blue }}>
                    {e.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DecisionBody({ d }: { d: SharedDecision }) {
  return (
    <>
      {d.status === "answered" && d.answer_index == null && d.answer_text && (
        <Callout label="Answer" tone="green">{d.answer_text}</Callout>
      )}
      {d.context_md && (
        <div style={{ marginBottom: 32 }}>
          <Prose content={d.context_md} />
        </div>
      )}
      {d.options.length > 0 && <DecisionOptions d={d} />}
    </>
  );
}
