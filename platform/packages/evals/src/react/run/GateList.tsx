// A rep's gates: the hard checks a reply must clear before any judged check
// counts. Failing gates come first. Each row has its own address
// (`#gate-<id>`), so a link from a list, a flip or a chat lands on it. Before
// a rep is scored, the gates its rubric names are drawn the same way, pending.

import type { ReactNode } from "react";
import { Link2 } from "lucide-react";
import { gateAnchor, orderGates, gateEvidenceWords } from "../../client";
import type { GateResultJson, RubricGate } from "../../contract";
import { VerdictGlyph } from "../shell/parts";

/** A row's link to itself: a plain click moves the address in place (the page lands on it), a modified click is the browser's. */
export function AnchorLink({ anchor, href, onAnchor, label }: { anchor: string; href: string; onAnchor: (anchor: string) => void; label: string }) {
  return (
    <a
      className="ev-row-anchor"
      href={href}
      aria-label={label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onAnchor(anchor);
      }}
    >
      <Link2 /> link
    </a>
  );
}

/** Where a row's own address points, and what a click on it does. */
export interface AnchorProps {
  /** The gate or check the address names, highlighted where it sits. */
  target: string | null;
  anchorHref: (anchor: string) => string;
  onAnchor: (anchor: string) => void;
}

/** One gate's row: its glyph, id, title and who decides it, then what the score found (nothing yet for a pending gate). */
function GateRow({ gate, glyph, failed = false, pending = false, children, p }: { gate: RubricGate; glyph: ReactNode; failed?: boolean; pending?: boolean; children?: ReactNode; p: AnchorProps }) {
  const anchor = gateAnchor(gate.id);
  return (
    <div id={anchor} className={`ev-row${failed ? " ev-row--gate-fail" : ""}`} data-ev-gate={gate.id} data-ev-gate-pass={pending ? undefined : !failed} data-ev-gate-pending={pending || undefined} data-ev-target={p.target === anchor}>
      <div className="ev-row-line">
        {glyph}
        <span className="ev-row-id">{gate.id}</span>
        {gate.title && <span className="ev-row-title">{gate.title}</span>}
        {gate.decidedBy && (
          <span className="ev-chip ev-decided" title={gate.decidedBy === "judge" ? "The judge decides this gate" : "Decided by code, no model involved"}>
            {gate.decidedBy}
          </span>
        )}
        <AnchorLink anchor={anchor} href={p.anchorHref(anchor)} onAnchor={p.onAnchor} label={`Link to gate ${gate.id}`} />
      </div>
      {children}
    </div>
  );
}

export function GateList({ gates, ...p }: { gates: readonly GateResultJson[] } & AnchorProps) {
  if (!gates.length)
    return (
      <div className="ev-rows">
        <div className="ev-empty-note">This surface declares no gates.</div>
      </div>
    );
  return (
    <div className="ev-rows" data-ev-gates>
      {orderGates(gates).map((g) => (
        <GateRow
          key={g.id}
          gate={g}
          failed={!g.pass}
          p={p}
          glyph={
            g.pass ? (
              <VerdictGlyph state={g.evidence.vacuous ? "dry" : "pass"} title={g.evidence.vacuous ? "held, nothing to check" : "held"} />
            ) : (
              <span className="ev-gate-x">
                <VerdictGlyph state="crash" title="gate failed" />
              </span>
            )
          }
        >
          <div className="ev-row-body">
            {gateEvidenceWords(g)}
            {!!g.evidence.excerpts?.length && g.evidence.scanned !== undefined && (
              <div className="ev-excerpt-count ev-tabular">
                {g.evidence.excerpts.length} of {g.evidence.scanned} scanned
              </div>
            )}
            {g.evidence.excerpts?.map((x, i) => (
              <div key={i} className="ev-excerpt">
                <span className="ev-excerpt-where">{x.where}</span>
                <span className="ev-excerpt-text">{x.text}</span>
              </div>
            ))}
          </div>
        </GateRow>
      ))}
    </div>
  );
}

/** Before a rep is scored: the gates its rubric names, in the rubric's order, each pending. */
export function RubricGates({ gates, ...p }: { gates: readonly RubricGate[] } & AnchorProps) {
  return (
    <div className="ev-rows" data-ev-rubric-gates>
      {gates.map((g) => (
        <GateRow key={g.id} gate={g} pending p={p} glyph={<VerdictGlyph state="unscored" title="not checked yet" />} />
      ))}
    </div>
  );
}
